---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Large models finish loading sooner after their geometry stream ends ([#6436](https://github.com/LTplus-AG/ifc-lite/issues/6436)). The renderer cannot finalize until its GPU upload queue has drained. That queue drained in 12 ms slices per frame, a budget meant to keep the main thread free for the worker pump while geometry streams, even after the stream had ended. On a 1 GB MEP model that left several seconds of uploads draining with the main thread ~40% idle.

- `Scene.flushPending(device, pipeline, budgetMs?)` takes an optional time slice. It defaults to the existing 12 ms, so current callers are unchanged.
- The viewer keeps 12 ms while geometry streams or the user navigates, and allows 32 ms otherwise.
