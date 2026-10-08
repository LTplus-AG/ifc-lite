# ADR-009: Claude-first, provider-neutral seam, eval-gated model availability

## Context
- The viewer already supports BYOK Anthropic/OpenAI and free models through a proxy (`lib/llm/*`, `packages/ai`).
- Quality differences between models on grounded tool use are large, and IDS correctness is the product.

## Decision
- Default model: `claude-opus-5-5`, with adaptive thinking and effort per mode, strict tools, prompt caching, task budgets and server-side refusal fallbacks (details in `03-architecture/06-ai-agent.md` §3).
- The provider-neutral interface stays in `packages/ai`.
- A model or provider is offered for a mode only if it passes that mode's eval gate (E2/E3 executable agreement within 3 pts of the default, audit pass 100%).
- Decision D2 can override.

## Consequences
- **+** Quality is guarded by measurement, not by preference.
- **−** Eval upkeep per model. Batch API and recorded replays keep it cheap.
