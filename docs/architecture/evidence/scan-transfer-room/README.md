# Transferred appearance through Share and room export

This browser acceptance uses the actual `transferred.ifczip` produced by the
[350-triangle transfer control](../scan-transfer-workspace/README.md). It verifies
portability of the applied scan appearance, including retained blue unknown
regions. It does not establish independent registration accuracy or larger-model
transfer capacity. Issue #4381 remains open for those and RGB-point adapters.

The viewer and relay were built from main `8a962988e` with Node 22.23.2. A fresh
local relay used an in-process random signing secret; no production room or
existing invite was used. [Runtime and artifact hashes](runtime.json) identify
the exact inputs. The full root build passed all 51 tasks. No product code changed.

## Journey and measured results

1. Open the transferred IFCZIP through the normal file input. The model has four
   meshes and 66,476 triangles, including the 350-triangle Transfer control region.
2. Use File → Share, then navigate the owner into the generated local signed room.
   [The connected owner can select the transferred object](owner-room-selected.png).
3. Open the link in a fresh browser context. [The guest selects the same object](guest-selected.png).
4. Close both contexts, open a new context and rejoin.
   [The transferred object remains selectable](rejoin-selected.png).
5. Use the normal room export dialog, save IFCX, and open it normally in another
   fresh context. [The reopened IFCX retains the selected object](reopened-selected.png).

Each selection uses a real mouse click on a projected triangle inside the main
viewer canvas after explicitly isolating the target. Isolation is cleared before
sharing or exporting, so the exported scope remains all four meshes. Screenshots
show the selection and properties; the earlier transfer control supplies the
[close appearance comparison](../scan-transfer-workspace/transfer-preview.png).

[Recorded comparisons](result.json) check every oriented corner of all 350 target
triangles in world coordinates and its associated UV. Owner room, guest, rejoin,
and reopened IFCX all have zero measured world-coordinate and UV differences
against the original loaded IFCZIP, with unchanged non-repeating sampler flags.
Numeric entity IDs change across room/import boundaries; the checks identify the
textured target and record its corresponding IFCX path rather than assuming IDs
are portable.

The 256 × 271 atlas is compared independently: Pillow decodes the original PNG
from IFCZIP, while the exported IFCX supplies embedded RGBA. **All 277,504 bytes
match**, including observed scan pixels and retained blue unknown pixels.
[Pixel proof](pixel-proof.json) records the SHA-256. Room transport preserves
decoded appearance; this is not a claim that it preserves the original compressed
PNG or JPEG bytes.

The disposable browser contexts, viewer server and relay were stopped after
acceptance. Large model files, raw geometry snapshots, relay data and signed
links are excluded from this evidence directory.
