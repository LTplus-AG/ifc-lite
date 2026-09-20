---
"@ifc-lite/renderer": patch
---

Fix `removePointCloudAsset` destroying a live streamed point-cloud asset after a device-loss recovery. Point-cloud handle ids are allocated by a per-instance counter that restarts at 1 on the replacement `PointCloudRenderer` teardown builds; a still-in-flight stream from before the teardown could carry a handle whose id was reissued to the new, live asset, and a late `removePointCloudAsset` call from that stale stream deleted the live one. `removePointCloudAsset` now checks the epoch the same way the streaming path already does, and the replacement `PointCloudRenderer` is seeded with a watermark so it never reissues an id a torn-down instance handed out. Normal removal of a current-epoch asset, including bounds recomputation, is unchanged.
