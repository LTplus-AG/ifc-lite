---
"@ifc-lite/renderer": patch
---

Fix a stale point-cloud stream destroying a live asset after a device-loss recovery. Point-cloud handle ids are allocated by a per-instance counter that restarts at 1 on the replacement `PointCloudRenderer` that teardown builds, so a still-in-flight stream from before the teardown could carry a handle whose id had been reissued to a new, live asset; a late removal call from that stale stream then deleted the live one. The replacement renderer is now seeded with the outgoing instance's watermark, so an id is never reissued across a teardown and a stale handle resolves to nothing. `removePointCloudAsset` itself is unchanged, and normal removal of a live asset, including bounds recomputation, behaves exactly as before.
