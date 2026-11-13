---
"@ifc-lite/viewer": patch
---

Opening a file or clearing the models while a clash, compare or workflow run is in progress now really ends that run. Clash and compare stop computing, and nothing is written into the new session afterwards: no clash progress, and no workflow result or cancellation error. Run stays disabled until a cancelled workflow has fully stopped, so clicking it no longer fails with "already running".
