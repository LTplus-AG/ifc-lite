---
"@ifc-lite/diff": minor
---

Add opt-in content-keyed matching to `diffModels` for comparing model revisions where GlobalIds are unreliable (issue #1891). A model re-exported from scratch gets entirely new GlobalIds, so the existing GlobalId-keyed diff reports every element as deleted-and-added even when nothing substantive changed.

Pass `{ matchUnpairedByContent: true }` to run a second pass, after the normal key-based pass, over the entities that came out `added`/`deleted`. It buckets them by `EntityFingerprint.dataHash` and reports the result via the new `ModelDiff.contentMatches: ContentMatch[]` field:

- exactly one leftover base entity and one leftover head entity sharing a data hash is an unambiguous match, reported as `renamed` (geometry hash also agrees — only the identity changed) or `moved` (it doesn't). The corresponding `added`/`deleted` pair is removed from `entries`/`byKey`/`counts` in favor of this single record.
- more than one candidate on either side is `duplicated` (one base entity, several head entities), `deduplicated` (several base entities, one head entity), or `ambiguous` (more than one on both sides).

**Ambiguity policy.** Ambiguous/duplicated/deduplicated groups are reported as-is — every candidate on both sides, via `ContentMatch.base`/`.head` — and the original `added`/`deleted` entries are left untouched in `entries` rather than collapsed into a guessed pairing. The alternative considered and rejected was picking the first candidate on each side (`candidates[0]`-style); the repo shipped exactly that class of silent-pick bug last week (#1923), and there is no principled way to decide *which* base entity became *which* head entity when several share a content hash. Resolving the group to a specific pairing, if desired, is left to the caller.

`DiffState`/`DiffEntry` are deliberately unchanged — a content match is reported only via the new `contentMatches` field, never by inventing a new `DiffEntry.state`, so an existing exhaustive `switch`/`Record` over `DiffState` elsewhere in a consumer keeps compiling unmodified.

Split and Merged (detecting a *partial* geometric overlap between one entity and several others, as requested in #1891) are deliberately not implemented: they need a geometric-similarity threshold and a policy for partial overlap that has no single correct answer. Left for a follow-up once that policy is decided.

Default `false` (unset) — existing callers of `diffModels` get byte-identical results; this is purely additive.

Not wired into the viewer's Compare panel, the MCP `diff` tool, or the CLI in this change — those are separate reviews.
