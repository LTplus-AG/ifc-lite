---
'@ifc-lite/renderer': patch
---

Camera inertia runs on the `deltaTime` passed to `Camera.update` instead of on frames. The inertia loop spent and damped each channel once per frame, so the same drag coasted further on a slow frame and stopped sooner on a 120 Hz display: a half-second orbit coasted half as far at 120 Hz and about 1.5 times as far at 30 fps as at 60 Hz. A 60 Hz tick behaves exactly as before. A missing or malformed `deltaTime` counts as one 60 Hz frame, and a tick after a stall spends at most 100 ms of coast.
