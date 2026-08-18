---
'@ifc-lite/bcf': patch
---

Fix `readBCF` failing to resolve a viewpoint's snapshot when `markup.bcf` names
it with a non-buildingSMART-convention filename.

`parseViewpoints` looked up each viewpoint's declared `<Viewpoint>`/`<Snapshot>`
filenames in `markup.bcf` with a regex matching the singular tag
`<Viewpoint Guid="...">`. The markup element that actually carries those
filenames is plural — `<Viewpoints Guid="...">`, per the BCF 2.1/3.0 schema and
this package's own writer (`writer.ts` `writeMarkupFile` emits exactly that tag)
— so the regex could never match a spec-correct file, and the lookup map was
always empty. Every snapshot resolution silently fell through to a
filename-guessing fallback (`Viewpoint_<guid>.bcfv` → `Snapshot_<guid>.png` and
similar patterns). That fallback happens to cover buildingSMART's own reference
fixtures, which follow the convention, but a third-party file is free to name
its entries however it likes; when the filenames don't match a guessed
pattern, the snapshot markup.bcf explicitly names was silently dropped even
though it exists in the archive.

The viewpoint's own GUID was never at risk — it comes from the `.bcfv` file's
`<VisualizationInfo Guid="...">` element directly, independent of this lookup
— so this was a snapshot-association defect, not a GUID/identity defect.

Fixed the regex to match the plural `<Viewpoints>` tag, so the markup-declared
filename is used when present and the naming-convention fallback now only
runs when markup.bcf genuinely doesn't declare a snapshot. Added a test using
a synthetic third-party-shaped archive (custom filenames, spec-legal) that
previously lost its snapshot and now resolves it, plus a regression test
against the buildingSMART `PerspectiveCamera.bcf` fixture.
