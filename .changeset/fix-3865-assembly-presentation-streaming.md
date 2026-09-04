---
"ifc-lite": patch
---

fix(viewer): assembly parts streaming in after a hide or isolate now respect it (#3865)

Presentation channels persist the complete set of aggregated descendants for an assembly, not just the parts that currently have geometry. Hide and isolate match mesh ids against a persisted set on every frame, so a part that streams in later is already in that set and is hidden or isolated the moment its mesh lands. Previously it escaped the action.

Colour is not fixed by this change. Both colour sinks in `useGeometryStreaming.ts` drain their pending map and clear it, and `scene.setColorOverrides` builds overlay batches once from `meshDataMap`, so a part whose mesh arrives after the flush is never painted. That is tracked separately in #3890.
