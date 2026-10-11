# P-03 — Studio UI v1

**Problem.** "The viewer has no IDS editor." The existing AI draft review only edits names, cardinality and simple values.

**Appetite.** 6 weeks, Track B.

**Solution.**
- A Studio panel with outline, inspector, grid and XML preview (see `02-product/03-ux-spec.md`).
- Schema-aware pickers, a value editor for all restriction kinds, diagnostics with quick fixes.
- Library v2 with revisions; import/export; templates; command palette.
- The old check-authoring IDS editor is superseded and deleted.

**Rabbit holes.**
- Grid editing semantics (paste of partial rows). Define paste = op batch per row with the gate; failing cells stay red; no partial-spec auto-creation magic.
- Picker performance with 1k+ entities. Virtualise and pre-index.
- Layout fights with existing panels. Use a layout preset; don't redesign the dock.

**No-gos.** No model features (P-05). No AI (P-07). No canvas (ADR-007). No comments (P-10).

**Scopes.** IDS-030 … IDS-045.

**Done means.**
- A new user can author and export a 10-spec IDS covering all six facets and all restriction kinds without touching XML.
- Zero audit errors possible at export.
- Keyboard-only flow works.

**Evidence.** Screen recording of the full flow; a11y check; screenshots in PRs.
