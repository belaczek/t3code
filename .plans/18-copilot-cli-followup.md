# GitHub Copilot CLI Follow-up

## Context

The initial `copilot` provider rollout is in place across contracts, web provider selection/settings surfaces, server provider wiring, git text generation routing, and a minimal runtime adapter. Core repo validations have already been run successfully:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- focused server test: `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`

This follow-up plan is for closing the remaining quality and product gaps without reopening the provider contract work.

## What shipped already

- `copilot` added to shared provider unions, settings, defaults, and model selection schemas
- web provider picker/settings/composer surfaces updated to recognize Copilot
- server provider registry and adapter registry extended to include Copilot
- `CopilotTextGeneration` added and routed for git text generation flows
- minimal `CopilotProvider` snapshot layer added
- minimal `CopilotAdapter` added with canonical runtime event emission

## Remaining gaps

1. **Provider registry test coverage**
   - Update `apps/server/src/provider/Layers/ProviderRegistry.test.ts` so the aggregate registry assertions explicitly include the Copilot provider.
   - Add a deterministic Copilot snapshot case using mocked command execution rather than relying on the local machine environment.

2. **Copilot runtime adapter tests**
   - Add a focused `CopilotAdapter.test.ts` covering:
     - session start
     - turn submission
     - emitted canonical events for a successful turn
     - unsupported actions (`attachments`, approvals, structured user input, interrupt)
     - rollback/read-thread behavior against locally stored history

3. **Copilot text generation tests**
   - Add a focused `CopilotTextGeneration.test.ts` mirroring the Codex/Claude test shape:
     - commit message generation
     - PR content generation
     - branch name generation
     - thread title generation
     - malformed JSON / CLI failure handling

4. **Provider snapshot behavior refinement**
   - Revisit whether the Copilot health probe should stay `auth: unknown` permanently or whether there is a safe documented non-interactive auth/status command worth using.
   - Keep the implementation conservative unless a documented command clearly improves signal without consuming quota or requiring interactive login.

5. **Documentation / UX clarity**
   - Add a short note in user-facing docs or settings copy describing the current Copilot v1 limitations:
     - no attachments
     - no approvals/user-input callbacks
     - no interrupt support
     - minimal local-history rollback only

## Recommended execution order

1. Update `ProviderRegistry.test.ts` for explicit Copilot coverage.
2. Add `CopilotAdapter.test.ts`.
3. Add `CopilotTextGeneration.test.ts`.
4. Decide whether auth probing should stay `unknown` or gain a documented probe.
5. Add minimal product-facing documentation for v1 limitations.
6. Re-run:
   - `bun fmt`
   - `bun lint`
   - `bun typecheck`
   - targeted new server tests

## Notes

- Do not invent unsupported Copilot session semantics just to reach parity with Codex/Claude.
- Prefer explicit unsupported errors over partial or misleading behavior.
- If future Copilot CLI docs expose a stable machine-readable session protocol, replace the current one-shot adapter internals behind the existing `copilot` provider boundary instead of changing contracts again.
