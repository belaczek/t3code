import { Effect, Layer, Schema } from "effect";

import { CopilotModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveApiModelId } from "@t3tools/shared/model";

import { ServerSettingsService } from "../../serverSettings.ts";
import { runProcess } from "../../processRunner.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";

const COPILOT_TIMEOUT_MS = 180_000;

function buildStructuredPrompt(prompt: string, outputSchema: Schema.Top): string {
  return `${prompt}

Return ONLY valid JSON matching this schema. Do not wrap it in Markdown fences.
${JSON.stringify(toJsonSchemaObject(outputSchema))}`;
}

const makeCopilotTextGeneration = Effect.gen(function* () {
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const runCopilotJson = Effect.fn("runCopilotJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CopilotModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const copilotSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.copilot,
    ).pipe(Effect.catch(() => Effect.undefined));

    const binaryPath = copilotSettings?.binaryPath || "copilot";
    const apiModel = resolveApiModelId(modelSelection);
    const structuredPrompt = buildStructuredPrompt(prompt, outputSchemaJson);

    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess(
          binaryPath,
          ["-p", structuredPrompt, "-s", "--no-ask-user", "--model", apiModel],
          {
            cwd,
            timeoutMs: COPILOT_TIMEOUT_MS,
          },
        ),
      catch: (cause) =>
        normalizeCliError("copilot", operation, cause, "Failed to run GitHub Copilot CLI"),
    });

    const stdout = result.stdout.trim();

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(stdout).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "GitHub Copilot CLI returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeFeatureBranchName(sanitizeBranchFragment(generated.branch)),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CopilotTextGenerationLive = Layer.effect(TextGeneration, makeCopilotTextGeneration);
