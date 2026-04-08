import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProvider,
  ServerProviderModel,
  ServerSettingsError,
} from "@t3tools/contracts";
import { Effect, Equal, Option, Result, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";

const PROVIDER = "copilot" as const;

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-0",
    name: "Claude Sonnet 4.0",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3-flash",
    name: "Gemini 3 Flash",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 mini",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.1",
    name: "GPT-5.1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
];

export function getCopilotModelCapabilities(_model: string | null | undefined): ModelCapabilities {
  return DEFAULT_COPILOT_MODEL_CAPABILITIES;
}

const unknownAuth: Pick<ServerProviderAuth, "status"> = {
  status: "unknown",
};

const runCopilotCommand = Effect.fn("runCopilotCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const copilotSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.copilot),
  );
  const command = ChildProcess.make(copilotSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: process.env,
  });
  return yield* spawnAndCollect(copilotSettings.binaryPath, command);
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const settingsService = yield* ServerSettingsService;
    const copilotSettings = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.copilot),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      copilotSettings.customModels,
      DEFAULT_COPILOT_MODEL_CAPABILITIES,
    );

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: unknownAuth,
        },
      });
    }

    const versionProbe = yield* runCopilotCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      const installed = !isCommandMissingCause(error);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed,
          version: null,
          status: installed ? "warning" : "error",
          auth: unknownAuth,
          message: installed
            ? `GitHub Copilot CLI is installed but could not be checked: ${error.message}`
            : "GitHub Copilot CLI was not found. Install it or update the configured binary path.",
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: unknownAuth,
          message: "GitHub Copilot CLI is installed but timed out while checking its version.",
        },
      });
    }

    const version = versionProbe.success.value;
    const versionOutput = `${version.stdout}\n${version.stderr}`;
    const parsedVersion = parseGenericCliVersion(versionOutput);
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: copilotSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: unknownAuth,
          message: detail
            ? `GitHub Copilot CLI is installed but failed to run. ${detail}`
            : "GitHub Copilot CLI is installed but failed to run.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: unknownAuth,
        message:
          "GitHub Copilot CLI is available. Authentication status is not probed non-interactively; run `copilot` and complete login if requests fail.",
      },
    });
  },
);

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.orDie,
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
