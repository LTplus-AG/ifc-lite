---
"@ifc-lite/viewer": patch
---

The first model you open no longer waits for the viewer to set itself up. While the welcome screen is idle, the viewer now mounts its 3D viewport behind it, hidden and inert, so the WebGPU device and its pipelines exist before a file arrives and the first open is a state change instead of a remount. Reopening a cached model in a fresh tab no longer waits ~0.3-0.5 s for the renderer before drawing. It is skipped on browsers that report under 4 GB of device memory or ask to save data, waits while the tab is hidden, and can be turned off with `?perf.warmShell=0`.
