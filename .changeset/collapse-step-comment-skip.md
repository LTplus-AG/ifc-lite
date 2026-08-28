---
'@ifc-lite/wasm': patch
---

Three places in `rust/` hand-rolled "skip a STEP `/* ... */` comment" and answered an unterminated `/*` three different ways. The entity scanner (`rust/core`) already refused rather than read past it; the `IfcTriangulatedFaceSet` CoordIndex reader (`rust/geometry`) instead silently consumed the rest of the entity's bytes looking for a close that would never come. Neither of those two had a reason to differ from the other — both are walking already-located record bytes, not a header prescan — so this collapses them onto one shared rule, `ifc_lite_core::skip_step_comment`, which refuses. The geometry crate's CoordIndex reader now refuses the same way the scanner already did, instead of scanning past the end of a corrupt record.

`rust/export`'s STEP HEADER prescan answers the same question differently on purpose (an unterminated `/*` there is treated as ordinary text, because a header prescan that swallows every later record has lost the schema, which is worse than the malformed input deserves) — see the doc comment on `source_header::Lex::skip_comment_at`. That call site now finds a *closed* comment's end via the same shared function too; only its own unterminated-comment answer stays its own.
