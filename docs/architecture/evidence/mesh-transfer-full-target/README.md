# Full selected-target scan transfer (#4381)

The complete selected boulder owner (40,087 triangles) now produces an applicable
appearance plan against all 66,122 source triangles. The two unselected wall
controls remain outside that explicit scope. This is a known-derived capture
control, **not independent real scan/BIM registration evidence**.

## Mechanism and limits

Nearest-first BVH traversal shrinks the query radius after exact primitive
measurements and retains the complete nearest-distance ambiguity band. Normal
rejection still follows geometric-nearest selection; a farther favourable normal
cannot replace an incompatible nearer surface. Transfer chart padding inherits
the nearest interior texel within its own chart. Interior unknown texels remain
unchanged, padding never counts as observed coverage, and a subpixel chart with
no interior retains its old appearance. The ordinary image/page shader keeps its
existing behavior.

The aggregate transfer work allowance changes from 64 million to 128 million
units. Scan-owned memory accounting remains 256 MiB and reserves the padding
scratch space before allocation. This is an explicit capacity change combined
with a different algorithm; the earlier experiments' refusal at 64 million
remains valid. Raising the work allowance alone still refused the full target.
A tripled overlapping source with 198,366 triangles refuses the memory budget;
there is no applicable output. The viewer also refuses this target at density
512 under the same memory limit. It never silently reduces the requested scope
or density.

## Browser and independent-reader acceptance

The normal viewer imports the capture IFCZIP and the CC0 Poly Haven boulder GLB
through the canonical loader. Four actual fit clicks and four held-out clicks
qualify the derived control. A blue appearance is applied first to make retained
unknown appearance visible. At density 256, the complete selected owner passes
Preview, Compare, Apply, toolbar Undo/Redo, ordinary IFCZIP export, fresh normal
import and actual mouse selection. The raster has 384,952 interior texels, of
which 233,073 are observed. Remaining texels keep the prior appearance; this is
conservative appearance transfer, not seamless texture synthesis.

[Independent IfcOpenShell 0.8.2 results](ifcopenshell.json) compare every oriented
triangle corner and UV against the fresh viewer import. IFC coordinates, indices
and placement are unchanged. The decoded atlas pixels match the fresh browser
exactly. [Preview](preview.png) and [fresh selection](reopened-selected.png)
show the actual generated result. Browser/source identifiers are recorded in
[browser-runtime.json](browser-runtime.json); its checkpoint includes the candidate runtime integrated with the reviewed
PDF-fill and authored-owner prerequisites.

## Shared-room portability

[The complete room journey](room.json) opens the transferred IFCZIP, uses normal
Share, joins as owner and as a fresh guest, closes both contexts, then joins in
a fresh context. Each state retains every oriented world/UV corner, decoded
image pixels and sampler settings. The room exports IFCX through the ordinary
export dialog; a fresh normal reopen retains all parts and actual mouse picking.
The relay is an isolated local authenticated server, not a production user room.
The test waits for initial seed completion before following the link; the separate
premature-share-readiness issue #4446 is not claimed fixed here.

## Worker capacity measurement

[worker.json](worker.json) records five fresh Chromium browser/context/module
workers on an otherwise idle machine. Every run returns identical complete IFPA
bytes, with an applicable plan and PNG assets. These worker controls use the
original target appearance and request, distinct from the blue-background viewer
journey; their coverage and atlas hashes must not be pooled. The report includes
API-call time, worker/roundtrip time, linear-memory high-water, heartbeat gaps
and sampled browser process-tree RSS. RSS includes input, JavaScript and browser
overhead, may double-count shared pages and is not an exact peak allocation.
Worker termination call latency is not operating-system reclamation latency.
This is one machine/model and a complete worker operation, not a worker-pool
throughput speedup or full Apply/export latency claim.

The [overlap refusal](overlap-refusal.json) is an actual WASM invocation. Its
elapsed time was collected during other work and is not a performance result.

## Reproduction

Use the qualified CC0 input and captured target described in
[the earlier capacity evidence](../mesh-transfer-capacity/README.md). Generate
its bounded JSON payload with `tools/texture-authoring/boulder-transfer-probe.py`.
Build the candidate WASM using `scripts/build-wasm.sh`, then run:

```sh
node tools/texture-authoring/transfer-capacity-worker.mjs \
  /path/to/checkout /tmp/transfer-input.json /tmp/worker.json
```

The harness owns and closes its browser/server/worker handles, permits only
fixed loopback routes and bounds file reads. It never publishes an IFC mutation.
For native metadata/refusal inspection, split the payload into `source.ifc`,
`request.json`, and decoded `rgba.bin`, then use the `transfer_capacity_probe`
processing example. No large third-party model is committed.
