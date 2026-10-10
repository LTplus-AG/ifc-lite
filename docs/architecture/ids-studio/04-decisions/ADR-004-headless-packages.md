# ADR-004: Headless-first package split

## Context
- Headless parity is a principle: CLI, MCP and SDK users (and CI) need the same authoring, lint, preview, agent and testgen capabilities.
- The viewer is one consumer among several.

## Decision
- New packages:
  - `@ifc-lite/ids-authoring`: doc, ops, gate, lint, diff, fmt, templates, test-suite model
  - `@ifc-lite/ids-model-loop`: funnel, explain, infer, coverage, distinct
  - `@ifc-lite/ids-agent`: loop, tools, ingestion, mapping
  - `@ifc-lite/ids-interop`: xlsx/yaml/appendix
  - `@ifc-lite/ids-testgen`: fixtures
- The viewer holds only UI, store slice and worker glue.
- If the maintainer prefers fewer published packages, model-loop, interop and testgen become subpath exports of ids-authoring. The agent stays separate because of its AI dependency surface.

## Consequences
- **+** CLI/MCP get features for free. Testable without DOM.
- **−** More packages: changesets, API surface snapshots, READMEs (CI-enforced). Subpath exports reduce this.

## Alternatives
- **Build inside `apps/viewer/src/lib/check-authoring`** (where AI IDS drafting lives today). Rejected: not reusable headless. The existing code there is superseded and deleted as the packages land.
