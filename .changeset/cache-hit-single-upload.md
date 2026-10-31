---
"@ifc-lite/renderer": minor
---

`SceneContents.limitStreamingFragments(maxIndices)` caps the current stream's transient fragment pass: past the budget a streamed mesh joins its bucket and is merged and uploaded once, by finalize, instead of twice. The time-sliced finalize also yields through a MessageChannel task instead of `setTimeout(0)`, avoiding the nested-timer clamp.
