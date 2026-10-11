# ADR-003: A grounding gate validates every operation before it applies

## Context
- Both LLM IDS generators we studied, and benchmark results (33% zero-shot content pass), show that names invented from memory are the dominant failure.
- Humans also make typos.
- ifc-lite has per-version schema tables (`@ifc-lite/data/ifc-schema`) and a bSDD client. Quantity-set tables are still incomplete for IFC2X3/IFC4 (IDS-009).

## Decision
- Every op passes `gate.check(ops, doc, ctx)` before the reducer runs.
- Literal standard names (entities, predefined types, attributes, `Pset_`/`Qto_` psets, their properties, enumeration values, data types) must resolve for every IFC version of the spec.
- Rejections are data `{code, path, message, candidates[]}`, returned to the UI and verbatim to the agent.
- Custom psets must be explicitly declared and must not use reserved prefixes.
- Patterns on names are allowed; lint handles them.

## Consequences
- **+** A standard-name rejection becomes a recoverable tool error. Grounding assurance applies only to names checked against complete tables; acceptance with incomplete tables is not proof a name exists.
- **+** The UI gets ranked "did you mean" suggestions for free.
- **−** Schema tables must be complete and correct. IDS-009 must fill the IFC2X3/IFC4 quantity-set gaps; a reserved `Qto_` name cannot be declared custom to bypass the gate. In the published P-02 checkpoint (#7168), `grounding-pset.ts` leaves `Qto_` names unverified when a version has no quantity-set table (`hasQuantitySets === false`); once that version has quantity rows, its reserved names are checked. This is a known grounding limitation, not the promised custom override or evidence of complete grounding. Keep it explicit until the missing tables and their gate controls are qualified.
- **−** bSDD offline means bSDD URIs can't be verified at edit time. The gate defers to a lint warning (non-blocking).

## Alternatives
- **Validate only at export.** Rejected: errors far from their cause, and the AI can't self-correct mid-run.
- **Constrained decoding with enum lists in tool schemas.** Rejected: thousands of names inflate the prompt and break caching. Lookups are cheaper and more precise.
