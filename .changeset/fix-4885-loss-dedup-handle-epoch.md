---
"@ifc-lite/renderer": patch
---

Device-loss recovery follow-ups (#4885 review): `removePointCloudAsset` keys its stream-epoch guard by handle id, so a caller that rebuilds `{ id }` for cleanup (the viewer's point-cloud lifecycle) actually frees the GPU asset again; and only the current device's `device.lost` signal advances the loss sequence while a loss is latched, so a late upload rejection from the dead device no longer aborts an in-flight recovery as a replacement loss.
