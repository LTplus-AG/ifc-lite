---
"@ifc-lite/viewer": patch
---

Large models finish loading much sooner ([#6411](https://github.com/LTplus-AG/ifc-lite/issues/6411)). While geometry streamed in, the hierarchy tree, the status-bar object count and the model statistics each rebuilt from the whole model on every geometry update (twice a second on a large file). On a 127K-element MEP model that kept the main thread saturated, so the geometry workers finished and then waited on it. In interleaved cold loads on a busy machine, full readiness went from 87–116 s to 54–61 s.

While a model streams, these panels now refresh every few seconds instead. They update at once for anything other than geometry, such as metadata arriving or another model being added, and they show the exact final result as soon as streaming ends.
