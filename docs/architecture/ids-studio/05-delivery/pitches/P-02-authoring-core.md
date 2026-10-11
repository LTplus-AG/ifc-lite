# P-02 — Authoring core: document, operations, grounding gate

**Problem.** Every authoring surface (UI, AI, import, CLI, MCP) needs the same way to change IDS safely. Without it, we repeat IDS-LLM-Service's failure: multiple representations and hallucinated names.

**Appetite.** 6 weeks, Track A (in parallel with P-01; depends on it only for the writer at the end).

**Solution.**
- `@ifc-lite/ids-authoring` containing:
  - `StudioDocument` with stable UUIDs;
  - the op vocabulary v1 (one JSON Schema shared by runtime validation and tool export) with a pure reducer and exact inverses;
  - compound ops;
  - the grounding gate with candidate ranking;
  - history and transactions;
  - sidecar and `.idsz`;
  - the re-identification matcher;
  - the plain-language renderer (in `@ifc-lite/ids`).
- See `03-architecture/02-document-model-and-ops.md`.

**Rabbit holes.**
- Over-designing compound ops. Ship the five that UI/AI need first (`applyTemplate`, `fromInference`, `fromBsddClass`, `fromMapping`, `renameProperty`) and add the rest when a consumer exists.
- Candidate ranking quality. Start with Damerau-Levenshtein + token overlap + hierarchy boost; tune later with E-sets.
- Immutable update performance on 500-spec docs. Benchmark early.

**No-gos.** No React. No persistence beyond an adapter interface. No collaboration (P-10).

**Scopes.** IDS-015 … IDS-027.

**Done means.**
- Every op is invertible (property test).
- The gate rejects 100% of a generated "hallucination" set (fake psets/props/enums/entities per version) and accepts 100% of corpus names.
- The renderer outputs reviewed en/de/fr/it strings.

**Evidence.** Test reports; a headless demo script that builds a 20-spec IDS from ops and exports valid XML.
