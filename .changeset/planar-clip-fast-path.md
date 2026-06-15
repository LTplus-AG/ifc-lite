---
"@ifc-lite/geometry": patch
---

Add an f64 planar-clip fast path for convex half-space end-clips — the dominant Tekla connection-cut pattern — replacing the exact CSG arrangement with a single plane clip plus cross-section cap when a solid or polygonally-bounded-half-space cutter acts as one half-space of the host.

`ClippingProcessor::subtract_one` now routes each single-cutter difference through `try_planar_clip` before the exact kernel. A cutter qualifies only when it is convex, exactly one of its face planes straddles the host, and the host lies entirely inside every other cutter face (the cutter overhangs the host on all but one side) — so notches, pockets, through-holes and non-convex cutters fall through to the exact arrangement unchanged. The clip caps the cut with the cross-section (outer boundary plus holes) wound for half-edge cancellation, producing a watertight solid geometrically equivalent to the exact subtract at roughly 100–150× lower cost per cut.

Three independent gates keep it correctness-safe — it is only ever a fast path, never a different answer:

- **convexity** — a cutter vertex outside any of its own face planes means the cutter is not a half-space, so defer;
- **precision regime** — host coordinates above the 10 km large-coordinate threshold defer, because f32 ULP exceeds a millimetre there and watertightness is unverifiable (un-localized georeferenced geometry degrades identically under the exact kernel, so deferring is never worse);
- **watertightness** — the capped result must have zero open boundary edges on the 1 mm grid, otherwise defer.

Wired into the solid-cutter difference, the single polygonally-bounded-half-space subtract (where it also sidesteps the coincident-side-wall sliver collapse the exact kernel hits when the clip polygon spans the host cross-section), and the extended-opening void cut. Set `IFC_LITE_DISABLE_PLANAR_CLIP=1` (native) to force the exact kernel everywhere. Validated shape- and volume-equivalent to the exact subtract on synthetic end-clips (watertight, <1.3e-4 volume deviation, 40/40 generic angled cuts) and via an A/B harness on real models (zero open-edge regressions, zero topology change across the full snapshot suite).
