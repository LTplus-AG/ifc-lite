# ADR-006: Separate Audit (conformance) and Lint (meaning) engines, one Diagnostic shape

## Context
- Users conflate "valid IDS" with "correct IDS".
- The audit answers the first question by reference to the standard. The second needs opinionated, documented rules, some of which need models.

## Decision
- **Audit** stays in `@ifc-lite/ids/audit`. Errors only; authority is the XSD plus Audit-Tool semantics. Target: all 27 invalid corpus cases detected.
- **Lint** lives in `@ifc-lite/ids-authoring/lint`, with codes `IDSL-AREA-nnn`, severities, quick fixes, docs and static/model modes.
- Both emit `Diagnostic`.

## Consequences
- **+** The audit can be compared 1:1 with the official tool (oracle), while lint can evolve and be opinionated without muddying conformance claims.
- **−** Two registries to maintain. A shared Diagnostic UI keeps the cost low.

## Alternatives
- **One engine.** Rejected: opinions would leak into conformance verdicts and make cross-tool comparison meaningless.
