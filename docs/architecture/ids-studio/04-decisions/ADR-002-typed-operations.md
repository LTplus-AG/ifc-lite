# ADR-002: All mutations are typed, invertible operations shared by every surface

## Context
- The UI, grid paste, AI, imports, bSDD, inference, CLI, MCP and collaboration all change IDS documents.
- If each writes the document differently, validation, undo and provenance have to be re-implemented N times.
- IDS-LLM-Service's best idea was LLM-proposed patch ops; its worst was having a different JSON schema from the writer.

## Decision
- A single versioned op vocabulary (`02-document-model-and-ops.md` §3) with a pure reducer and exact inverses.
- Compound ops expand to primitives.
- Operation tool definitions use `getOpJsonSchema()` from `@ifc-lite/ids-authoring`; runtime `validateOp` interprets that same JSON Schema before the gate and reducer. The P-02 implementation supersedes the original zod proposal (see `03-architecture/02-document-model-and-ops.md` §8–9); consumers must not introduce a duplicate operation schema.
- Transactions group ops into one history entry.

## Consequences
- **+** Undo/redo, history, provenance, diff, collaboration (op → Yjs) and AI proposals come from one mechanism.
- **+** The AI's contract can't drift from the reducer.
- **−** Upfront design cost. The vocabulary must be stable early, so it is versioned (`opsVersion`) with migrations.
- **−** Some UI gestures need compound ops. That is acceptable.

## Alternatives
- **Direct immutable updates from React components.** Rejected: no shared validation, and the AI would need a second path.
- **JSON Patch (RFC 6902).** Rejected: path-based, not semantic. It can't carry gate semantics or readable diffs.
