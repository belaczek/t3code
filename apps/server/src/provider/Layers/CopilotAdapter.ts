import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Data, Effect, Layer, Queue, Ref, Result, Stream } from "effect";

import { resolveApiModelId } from "@t3tools/shared/model";

import { runProcess } from "../../processRunner.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "copilot" as const;
const COPILOT_TIMEOUT_MS = 300_000;

class CopilotTurnProcessError extends Data.TaggedError("CopilotTurnProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CopilotResumeTurn {
  readonly id: string;
  readonly userInput: string;
  readonly assistantText?: string | undefined;
}

interface CopilotResumeCursor {
  readonly kind: "copilot-cli";
  readonly turns: ReadonlyArray<CopilotResumeTurn>;
}

interface CopilotStoredTurn {
  readonly id: TurnId;
  readonly userInput: string;
  readonly assistantText?: string | undefined;
}

interface CopilotSessionContext {
  readonly session: ProviderSession;
  readonly turns: ReadonlyArray<CopilotStoredTurn>;
}

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId() {
  return EventId.makeUnsafe(randomUUID());
}

function makeTurnId() {
  return TurnId.makeUnsafe(randomUUID());
}

function makeRuntimeItemId(turnId: TurnId) {
  return RuntimeItemId.makeUnsafe(`${turnId}:assistant`);
}

function toResumeCursor(turns: ReadonlyArray<CopilotStoredTurn>): CopilotResumeCursor {
  return {
    kind: "copilot-cli",
    turns: turns.map((turn) => ({
      id: turn.id,
      userInput: turn.userInput,
      ...(turn.assistantText ? { assistantText: turn.assistantText } : {}),
    })),
  };
}

function fromResumeCursor(value: unknown): ReadonlyArray<CopilotStoredTurn> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const cursor = value as Partial<CopilotResumeCursor>;
  if (cursor.kind !== "copilot-cli" || !Array.isArray(cursor.turns)) {
    return [];
  }

  return cursor.turns.flatMap((turn): ReadonlyArray<CopilotStoredTurn> => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      return [];
    }
    const record = turn as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.userInput !== "string") {
      return [];
    }
    return [
      {
        id: record.id as TurnId,
        userInput: record.userInput,
        ...(typeof record.assistantText === "string"
          ? { assistantText: record.assistantText }
          : {}),
      },
    ];
  });
}

function buildPrompt(history: ReadonlyArray<CopilotStoredTurn>, input: string): string {
  if (history.length === 0) {
    return input;
  }

  const transcript = history
    .map((turn) =>
      [
        `User:\n${turn.userInput}`,
        typeof turn.assistantText === "string" ? `Assistant:\n${turn.assistantText}` : null,
      ]
        .filter((part): part is string => typeof part === "string")
        .join("\n\n"),
    )
    .join("\n\n---\n\n");

  return `Continue this conversation faithfully.

Conversation so far:
${transcript}

New user message:
${input}`;
}

function toRequestError(
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function sessionNotFound(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function sessionClosed(threadId: ThreadId): ProviderAdapterSessionClosedError {
  return new ProviderAdapterSessionClosedError({
    provider: PROVIDER,
    threadId,
  });
}

function readSession(
  sessions: Map<ThreadId, CopilotSessionContext>,
  threadId: ThreadId,
): Effect.Effect<CopilotSessionContext, ProviderAdapterError> {
  const session = sessions.get(threadId);
  if (!session) {
    return Effect.fail(sessionNotFound(threadId));
  }
  if (session.session.status === "closed") {
    return Effect.fail(sessionClosed(threadId));
  }
  return Effect.succeed(session);
}

function threadItemsForTurn(turn: CopilotStoredTurn): ReadonlyArray<unknown> {
  return [
    {
      type: "user_message",
      role: "user",
      content: turn.userInput,
    },
    ...(typeof turn.assistantText === "string"
      ? [
          {
            type: "assistant_message",
            role: "assistant",
            content: turn.assistantText,
          },
        ]
      : []),
  ];
}

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  options?: CopilotAdapterLiveOptions,
) {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const turnWorkQueue = yield* Queue.unbounded<Effect.Effect<void, never>>();
  const sessionsRef = yield* Ref.make(new Map<ThreadId, CopilotSessionContext>());
  const serverSettingsService = yield* ServerSettingsService;

  const emitEvent = (event: ProviderRuntimeEvent): Effect.Effect<void, never> =>
    Effect.all(
      [
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
        options?.nativeEventLogger?.write(event, event.threadId) ?? Effect.void,
      ],
      { concurrency: "unbounded", discard: true },
    );

  const emitSessionStarted = (threadId: ThreadId, resumeCursor: unknown | undefined) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      type: "session.started",
      payload: resumeCursor !== undefined ? { resume: resumeCursor } : {},
    });

  const emitSessionStateChanged = (
    threadId: ThreadId,
    state: "starting" | "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      type: "session.state.changed",
      payload: {
        state,
        ...(reason ? { reason } : {}),
      },
    });

  const emitThreadStarted = (threadId: ThreadId) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      type: "thread.started",
      payload: {
        providerThreadId: threadId,
      },
    });

  const emitTurnStarted = (threadId: ThreadId, turnId: TurnId, model?: string) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      turnId,
      createdAt: nowIso(),
      type: "turn.started",
      payload: model ? { model } : {},
    });

  const emitContentDelta = (threadId: ThreadId, turnId: TurnId, text: string) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      turnId,
      itemId: makeRuntimeItemId(turnId),
      createdAt: nowIso(),
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: text,
        contentIndex: 0,
      },
    });

  const emitTurnCompleted = (
    threadId: ThreadId,
    turnId: TurnId,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      turnId,
      createdAt: nowIso(),
      type: "turn.completed",
      payload: {
        state,
        stopReason: state === "completed" ? "completed" : "error",
        ...(errorMessage ? { errorMessage } : {}),
      },
    });

  const emitRuntimeError = (
    threadId: ThreadId,
    turnId: TurnId,
    message: string,
    detail?: unknown,
  ) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      turnId,
      createdAt: nowIso(),
      type: "runtime.error",
      payload: {
        message,
        class: "provider_error",
        ...(detail !== undefined ? { detail } : {}),
      },
    });

  const emitSessionExited = (threadId: ThreadId, reason?: string) =>
    emitEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId,
      createdAt: nowIso(),
      type: "session.exited",
      payload: {
        exitKind: "graceful",
        ...(reason ? { reason } : {}),
      },
    });

  yield* Effect.forkScoped(
    Effect.forever(Queue.take(turnWorkQueue).pipe(Effect.flatMap((job) => job))),
  );

  const startSession: CopilotAdapterShape["startSession"] = Effect.fn(function* (
    input: ProviderSessionStartInput,
  ) {
    if (input.modelSelection?.provider && input.modelSelection.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "session/start",
        issue: "Copilot adapter received a non-Copilot model selection.",
      });
    }

    const createdAt = nowIso();
    const turns = fromResumeCursor(input.resumeCursor);
    const session: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
      threadId: input.threadId,
      ...(turns.length > 0 ? { resumeCursor: toResumeCursor(turns) } : {}),
      createdAt,
      updatedAt: createdAt,
    };

    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.set(input.threadId, { session, turns });
      return next;
    });

    yield* emitSessionStarted(input.threadId, session.resumeCursor);
    yield* emitThreadStarted(input.threadId);
    yield* emitSessionStateChanged(input.threadId, "ready");

    return session;
  });

  const sendTurn: CopilotAdapterShape["sendTurn"] = Effect.fn(function* (
    input: ProviderSendTurnInput,
  ) {
    if (input.attachments && input.attachments.length > 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "GitHub Copilot CLI turns do not support attachments in this adapter yet.",
      });
    }
    if (!input.input) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "turn/start",
        issue: "Turn input must be a non-empty string.",
      });
    }
    if (input.modelSelection?.provider && input.modelSelection.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "turn/start",
        issue: "Copilot adapter received a non-Copilot model selection.",
      });
    }

    const sessions = yield* Ref.get(sessionsRef);
    const current = yield* readSession(sessions, input.threadId);
    if (current.session.activeTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "A Copilot turn is already active for this thread.",
      });
    }

    const turnId = makeTurnId();
    const model = input.modelSelection?.model ?? current.session.model;
    const updatedSession: ProviderSession = {
      ...current.session,
      status: "running",
      activeTurnId: turnId,
      ...(model ? { model } : {}),
      updatedAt: nowIso(),
    };

    yield* Ref.update(sessionsRef, (allSessions) => {
      const next = new Map(allSessions);
      next.set(input.threadId, {
        ...current,
        session: updatedSession,
      });
      return next;
    });

    const result: ProviderTurnStartResult = {
      threadId: input.threadId,
      turnId,
      ...(current.session.resumeCursor !== undefined
        ? { resumeCursor: current.session.resumeCursor }
        : {}),
    };

    yield* Queue.offer(
      turnWorkQueue,
      Effect.gen(function* () {
        yield* emitSessionStateChanged(input.threadId, "running");
        yield* emitTurnStarted(input.threadId, turnId, model);

        const latestSessions = yield* Ref.get(sessionsRef);
        const latest = latestSessions.get(input.threadId);
        if (!latest || latest.session.status === "closed") {
          yield* emitTurnCompleted(input.threadId, turnId, "cancelled", "Session was closed.");
          return;
        }

        const settings = yield* Effect.map(
          serverSettingsService.getSettings,
          (serverSettings) => serverSettings.providers.copilot,
        ).pipe(Effect.catch(() => Effect.void));

        const binaryPath = settings?.binaryPath || "copilot";
        const resolvedModel = resolveApiModelId(
          input.modelSelection ?? {
            provider: PROVIDER,
            model: latest.session.model || "claude-sonnet-4-5",
          },
        );
        const prompt = buildPrompt(latest.turns, input.input ?? "");

        const processResult = yield* Effect.tryPromise({
          try: () =>
            runProcess(
              binaryPath,
              ["-p", prompt, "-s", "--no-ask-user", "--model", resolvedModel],
              {
                cwd: latest.session.cwd,
                timeoutMs: COPILOT_TIMEOUT_MS,
              },
            ),
          catch: (cause) =>
            new CopilotTurnProcessError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(Effect.result);

        if (Result.isFailure(processResult)) {
          const detail = processResult.failure.message;
          yield* Ref.update(sessionsRef, (allSessions) => {
            const existing = allSessions.get(input.threadId);
            if (!existing) {
              return allSessions;
            }
            const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = existing.session;
            const next = new Map(allSessions);
            next.set(input.threadId, {
              ...existing,
              session: {
                ...sessionWithoutActiveTurn,
                status: "error",
                updatedAt: nowIso(),
                lastError: detail,
              },
            });
            return next;
          });
          yield* emitRuntimeError(input.threadId, turnId, detail);
          yield* emitTurnCompleted(input.threadId, turnId, "failed", detail);
          yield* emitSessionStateChanged(input.threadId, "error", detail);
          return;
        }

        const assistantText = processResult.success.stdout.trim();
        const nextTurn: CopilotStoredTurn = {
          id: turnId,
          userInput: input.input ?? "",
          assistantText,
        };

        yield* Ref.update(sessionsRef, (allSessions) => {
          const existing = allSessions.get(input.threadId);
          if (!existing) {
            return allSessions;
          }
          const turns = [...existing.turns, nextTurn];
          const {
            activeTurnId: _activeTurnId,
            lastError: _lastError,
            ...sessionWithoutActiveTurn
          } = existing.session;
          const next = new Map(allSessions);
          next.set(input.threadId, {
            turns,
            session: {
              ...sessionWithoutActiveTurn,
              status: "ready",
              model: resolvedModel,
              resumeCursor: toResumeCursor(turns),
              updatedAt: nowIso(),
            },
          });
          return next;
        });

        if (assistantText.length > 0) {
          yield* emitContentDelta(input.threadId, turnId, assistantText);
        }
        yield* emitTurnCompleted(input.threadId, turnId, "completed");
        yield* emitSessionStateChanged(input.threadId, "ready");
      }),
    ).pipe(Effect.asVoid);

    return result;
  });

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => readSession(sessions, threadId)),
      Effect.map((session) => ({
        threadId,
        turns: session.turns.map((turn) => ({
          id: turn.id,
          items: threadItemsForTurn(turn),
        })),
      })),
    );

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = Effect.fn(function* (
    threadId: ThreadId,
    numTurns: number,
  ) {
    if (!Number.isInteger(numTurns) || numTurns <= 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "thread/rollback",
        issue: "numTurns must be a positive integer.",
      });
    }

    const sessions = yield* Ref.get(sessionsRef);
    const current = yield* readSession(sessions, threadId);
    const turns = current.turns.slice(0, Math.max(0, current.turns.length - numTurns));

    yield* Ref.update(sessionsRef, (allSessions) => {
      const next = new Map(allSessions);
      next.set(threadId, {
        turns,
        session: {
          ...current.session,
          resumeCursor: toResumeCursor(turns),
          updatedAt: nowIso(),
        },
      });
      return next;
    });

    return {
      threadId,
      turns: turns.map((turn) => ({
        id: turn.id,
        items: threadItemsForTurn(turn),
      })),
    };
  });

  const respondToRequest = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ) =>
    Effect.fail(
      toRequestError(
        "item/requestApproval/decision",
        "GitHub Copilot CLI does not expose approval requests through this adapter.",
      ),
    );

  const respondToUserInput = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    Effect.fail(
      toRequestError(
        "item/tool/requestUserInput",
        "GitHub Copilot CLI does not expose structured user input requests through this adapter.",
      ),
    );

  const stopSessionInternal = (threadId: ThreadId, emitExitEvent: boolean) =>
    Ref.modify(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      const current = next.get(threadId);
      if (!current) {
        return [undefined, sessions] as const;
      }
      const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = current.session;
      next.set(threadId, {
        ...current,
        session: {
          ...sessionWithoutActiveTurn,
          status: "closed",
          updatedAt: nowIso(),
        },
      });
      return [current, next] as const;
    }).pipe(
      Effect.flatMap((current) => {
        if (!current) {
          return Effect.fail(sessionNotFound(threadId));
        }
        return emitExitEvent ? emitSessionExited(threadId).pipe(Effect.asVoid) : Effect.void;
      }),
    );

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    stopSessionInternal(threadId, true);

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Ref.get(sessionsRef).pipe(
      Effect.map((sessions) => Array.from(sessions.values(), (entry) => entry.session)),
    );

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId)));

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          Array.from(sessions.keys()),
          (threadId) => stopSessionInternal(threadId, false),
          {
            discard: true,
          },
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(Queue.shutdown(turnWorkQueue)),
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
    ),
  );

  const interrupt: CopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.fail(
      toRequestError(
        "turn/interrupt",
        `GitHub Copilot CLI turns cannot be interrupted once started (thread: ${threadId}).`,
      ),
    );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn: interrupt,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
