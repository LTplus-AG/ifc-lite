---
'@ifc-lite/export': patch
---

`splitTopLevelStepArguments`'s outer comma/paren/quote scan is now
comment-aware, and `rescaleEntityLengths`'s `findOuterArgs` span-finder
(moved to its own module, `step-outer-args.ts`) is too.

ISO-10303-21 comment (`/* ... */`) content is unrestricted text: a comma, an
unbalanced paren, or an odd number of `'` inside one is legal and occurs in
real files, but neither scan previously skipped a comment as a unit — each
read the comment's raw characters as argument-list structure. A comma inside
a comment was read as a top-level separator, producing a phantom fragment
that begins with `/` (outside every STEP token's character set), which the
per-part well-formedness check added for #4162 then rejected — turning a
fully legal line into a `null` split. Separately, an apostrophe or unbalanced
paren inside a comment could make `findOuterArgs` miss a record's own closing
`)` entirely.

Previously both failure modes were silent: `rescaleEntityLengths` read the
`null`/missing span as "nothing to rescale" and returned the line's
length/area/volume data unscaled. A follow-up in this same series made the
`splitTopLevelStepArguments` case throw instead (correct for a function with
no safe permissive fallback for a unit conversion) — which meant a legal
comment could abort an otherwise-legal export. Both scans now skip a
`/* ... */` region wholesale, so a comment's content can no longer be
misread as structure in either direction.

The #4162 per-part rejection itself is unchanged: a comment standing alone as
its own slot (no value) is still rejected, and a phantom string swallowing a
real argument boundary is still rejected.
