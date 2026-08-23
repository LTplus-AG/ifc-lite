---
'@ifc-lite/geometry': major
'@ifc-lite/export': major
'@ifc-lite/cli': minor
'@ifc-lite/viewer': patch
---

Remove two advertised-but-unread option surfaces, and with them the `--quality`
CLI flag. Both were found by the issue #2731 audit; an earlier changeset marked
the audit's inert *fields* `@deprecated` and deliberately left these two out,
because each carries a behaviour decision rather than only a doc fix. This is
that decision, taken as removal.

**`DynamicBatchConfig.initialBatchSize` / `.maxBatchSize` (`geometry`,
breaking).** The interface promised a ramp-up — small first batches for a fast
first frame, larger ones later. No ramp-up exists.
`getStreamingBatchSize` reads `fileSizeMB` alone (falling back to the buffer's
own length when it is absent or zero) and returns a fixed value off a size
ladder; the two size fields were never read on any path. `DynamicBatchConfig`
is now `{ fileSizeMB?: number }`. Streaming behaviour is unchanged for every
caller — the values were already ignored — but an object literal that still
sets either field is now an excess-property error. Delete the fields; the
resulting batch sizes are identical.

**`GeometryProcessorOptions.quality` and the `GeometryQuality` enum
(`geometry`, breaking).** The constructor discarded the value (`void
options.quality;`) and nothing downstream consulted it, so `Fast`, `Balanced`
and `High` selected exactly the same geometry. The field and the exported
`GeometryQuality` enum are both gone. Callers wanting a real detail-level
control want `tessellationQuality` (`'lowest' | 'low' | 'medium' | 'high' |
'highest'`), which is honoured by the WASM pipeline.

**`GenerateLod1Options.quality` (`export`, breaking).** It existed only to
forward into the discard above. Removed.

**`ifc-lite lod --quality` (`cli`, user-visible removal).** The flag accepted
`low | medium | high | fast | balanced`, validated the value, rejected anything
else with a non-zero exit — and then fed the result into the discarded field.
Every accepted value produced byte-identical LOD1 output. The flag is removed
rather than left validating into nothing: a command that still fails on
`--quality gorgeous` while ignoring `--quality low` misleads more than an
unknown-flag path does. Scripts passing it need the flag dropped; the generated
GLB and metadata are unchanged.

`geometry` and `export` take `major` because a public export is removed and
optional fields disappear from published types — the repo's own API-surface
guard puts a removed export at `major` for a package at or past 1.0. `cli` is
`0.x` and takes `minor` for the flag removal.
