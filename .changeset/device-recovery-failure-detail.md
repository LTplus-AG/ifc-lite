---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

A failed GPU device recovery now says what failed. When a replacement device is lost before recovery finishes, the renderer's `device-init-failed` error carries that device's own loss reason and text (`Replacement GPU device was lost during initialization (unknown): …`) instead of a fixed sentence. The viewer's `device_loss_recovery_failed` event adds the error class and text of the final attempt and of the first attempt when it was retried, the attempt count, elapsed time, a per-page episode number, and the same GPU and page context as the loss event.
