# P-01 — Engine completeness

**Problem.**
- The writer refuses length/digit and conjunctive restrictions that the model can represent. Studio would either lose data or crash on export.
- The audit misses 21 of the 27 invalid corpus files, so "valid by construction" can't yet be claimed against the standard's own tests.
- The writer lives in `rules`, away from the types it serialises.
- IFC2X3/IFC4 have no Qto tables, so a gate would reject valid quantity names.

**Appetite.** 6 weeks, Track A.

**Solution.**
- Make the writer total (all `IDSConstraint` shapes) and move it into `@ifc-lite/ids` (ADR-005).
- Classify the undetected invalid cases into families; fix one family per PR until `AUDIT_UNDETECTED` is empty.
- Audit conjunctive siblings.
- Generate Qto tables.
- Add canonical formatting.
- Add a property-based round trip.
- Add a CI oracle against the official audit CLI.

**Rabbit holes.**
- The official XSD has known parser problems (IDS #422/#423). Don't block on XSD-tool parity; our TS rules are the spec.
- Some "invalid" corpus cases may be ambiguous upstream. Document them and file upstream rather than encoding a guess.
- Qto data source licence: the generator source is the same audit-tool SchemaInfo (MIT). Verify.

**No-gos.** No new facets. No IDS 1.1. No UI.

**Scopes.** IDS-001 … IDS-014.

**Done means.**
- `parse∘write = id` (property test, 10k cases).
- `AUDIT_UNDETECTED.length === 0`.
- CI oracle job green, or every disagreement triaged.

**Evidence.** Corpus run output in each PR; oracle report.
