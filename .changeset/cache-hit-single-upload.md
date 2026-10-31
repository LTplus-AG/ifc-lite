---
"@ifc-lite/renderer": minor
---

`SceneContents.limitStreamingFragments(maxIndices)` stops the current stream's transient fragment pass near a first-paint target: past it a streamed mesh joins its bucket and is merged and uploaded once, by finalize, instead of twice. The time-sliced finalize also yields through a MessageChannel task instead of `setTimeout(0)`, avoiding the nested-timer clamp.
