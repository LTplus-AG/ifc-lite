---
"@ifc-lite/viewer": patch
---

Adding a model while another add is still loading no longer reports the first one as failed (#9497). `addModel` used to return no model id whenever a newer add had started, even though its model had loaded. A blank Scan-to-BIM or captured-surfaces model then showed "failed", a reloaded model lost its tags, and a reopened federation setup counted the slot as failed. `addModel` now returns the id whenever this add's model is in the federation. A reopened federation setup also names each failed slot's own reason, including a retained-kernel refusal, instead of whatever error another load last showed.
