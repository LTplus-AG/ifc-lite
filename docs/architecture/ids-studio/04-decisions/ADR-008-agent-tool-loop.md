# ADR-008: The AI agent is a tool-use loop over the op vocabulary

## Context
- Fixed pipelines of JSON-generation calls (IDS-LLM-Service: 4–9 calls per spec) are brittle and expensive, and can't look anything up.
- The ifc-lite assistant today answers with JSON proposals and has no tool calling.

## Decision
- `@ifc-lite/ids-agent` runs a tool-use loop.
- Read tools: schema, bSDD, model, IDS, sources.
- Act tools: `ids.apply_ops` on a sandbox fork (gate → reducer → diagnostics → preview), `ids.apply_fix`, `ids.mark_unresolved`, `ids.ask_user` (structured choices, each a ready op batch with counts).
- Stop on end of turn, task budget, no-progress signature, cancel or timeout.
- Output is a Proposal reviewed by the user.
- Clarification happens only when tools return ≥2 materially different candidates.

## Consequences
- **+** Grounding by construction. Self-correction from precise feedback. One code path for UI, CLI and MCP.
- **+** The same tools are exposed via MCP, so external agents get the gate.
- **−** Agent loops have variable cost. Mitigated by task budgets, effort per mode and prompt caching, with cost tracked per run.
- **−** Supersedes the JSON-proposal IDS path in the assistant. Migrate, then delete `ids-proposal.ts` parsing.

## Alternatives
- **Single-shot structured output of a full IDS JSON.** Rejected: no grounding; this is the benchmark's 33% regime.
- **Fine-tuned small model** (the Ishigaki approach). Not rejected forever, but deferred. Revisit if eval shows tool-grounded frontier models plateau. A local model could serve an offline mode later.
