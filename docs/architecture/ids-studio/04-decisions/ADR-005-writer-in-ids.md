# ADR-005: Move the IDS writer into `@ifc-lite/ids` and make it total

## Context
- `writeIdsXml` lives in `packages/rules/src/ids/` and refuses length/digit restrictions and conjunctive (`and[]`) restriction facets.
- `IDSConstraint` already models both.
- Authoring needs a writer that can serialise everything the model can represent, in the package that owns the model.

## Decision
- Move `ids-xml-writer.ts` (and its oracle tests) to `@ifc-lite/ids/writer`.
- `rules` imports it from there (supersede means delete; no re-export shim beyond one release if API policy requires).
- Implement length/minLength/maxLength/totalDigits/fractionDigits and conjunctive restrictions.
- Add canonical formatting options (`fmt`).
- Extend the oracle: every corpus pass/fail case written and read back gives identical verdicts, and every invalid case is either refused with a reason or written in valid form.

## Consequences
- **+** `parse ∘ write` is identity on the whole model space. That is a property test.
- **−** Published API move: `@ifc-lite/rules` minor/major per semver rules, plus changesets, API-surface update and a docs grep.

## Alternatives
- **New writer in ids-authoring.** Rejected: two writers. The existing one is oracle-tested; extend it.
