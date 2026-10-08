# ADR-003: A grounding gate validates every operation before it applies

## Context
- Both LLM IDS generators we studied, and benchmark results (33% zero-shot content pass), show that names invented from memory are the dominant failure.
- Humans also make typos.
- ifc-lite has complete per-version schema tables (`@ifc-lite/data/ifc-schema`) and a bSDD client.

## Decision
- Every op passes `gate.check(ops, doc, ctx)` before the reducer runs.
- Literal standard names (entities, predefined types, attributes, `Pset_`/`Qto_` psets, their properties, enumeration values, data types) must resolve for every IFC version of the spec.
- Rejections are data `{code, path, message, candidates[]}`, returned to the UI and verbatim to the agent.
- Custom psets must be explicitly declared and must not use reserved prefixes.
- Patterns on names are allowed; lint handles them.

## Consequences
- **+** Hallucination becomes a recoverable tool error. Exported IDS cannot contain non-existent standard names.
- **+** The UI gets ranked "did you mean" suggestions for free.
- **−** Schema tables must be complete and correct. Gaps (Qto tables for IFC2X3/IFC4) must be filled (IDS-009), otherwise legitimate names get rejected. Mitigation: a per-name "override as custom" escape hatch with a lint warning.
- **−** bSDD offline means bSDD URIs can't be verified at edit time. The gate defers to a lint warning (non-blocking).

## Alternatives
- **Validate only at export.** Rejected: errors far from their cause, and the AI can't self-correct mid-run.
- **Constrained decoding with enum lists in tool schemas.** Rejected: thousands of names inflate the prompt and break caching. Lookups are cheaper and more precise.
