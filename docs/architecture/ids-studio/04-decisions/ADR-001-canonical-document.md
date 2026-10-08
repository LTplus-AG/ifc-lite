# ADR-001: Canonical document = `@ifc-lite/ids` types + Studio sidecar with stable IDs

## Context
- Authoring needs stable identity for every node: undo, diff, comments, provenance, collaboration and AI references all depend on it.
- `IDSDocument` (in `@ifc-lite/ids`) is the type the parser, validator, audit and writer already share.
- Specs and requirements carry positional `id`s; applicability facets have none.
- Inventing a parallel "editor model" would duplicate semantics and drift from the validator.

## Decision
- `StudioDocument = { docId, ids: IDSDocument, nodes: NodeIndex (UUIDv7 ↔ path), meta: StudioMeta }`.
- `ids` stays pure IDS content.
- Everything Studio-specific lives in `meta`: provenance, sources, comments, suppressions, tests, revisions, mappings, unresolved, custom declarations. It is persisted as a sidecar (`studio.json` / IndexedDB), never in XML.

## Consequences
- **+** The validator, audit and writer work on the same object the editor edits. Preview ≡ result.
- **+** IDS files stay standard (ADR-011).
- **−** Node identity must be re-established on external imports. A matching cascade is shared with diff: identifier → name+signature → similarity.
- **−** The sidecar can get lost when only XML is shared. The `.idsz` bundle and the optional XML-comment fingerprint mitigate this.

## Alternatives considered
- **Separate editor AST** (ids-flow's graph). Rejected: duplicated semantics, and its import/export bugs show the cost.
- **Store IDs in XML** via custom attributes/namespaces. Rejected: breaks "standard, not dialect"; other tools may reject unknown attributes.
