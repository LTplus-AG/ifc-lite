---
"@ifc-lite/renderer": patch
---

Upload static geometry (batch vertex/index/LOD buffers, instanced template and instance buffers, and their device-recovery rebuilds) with `queue.writeBuffer` instead of `createBuffer({ mappedAtCreation: true })` (#5429). On Chromium (Chrome / Edge / WebView2), a mapped-at-creation buffer keeps a shared-memory copy of its full contents for as long as it lives, so a loaded scene carried a hidden second copy of all its GPU geometry in system commit. Every site now goes through one helper, `createStaticGpuBuffer`, which pads payloads to the 4-byte multiple `writeBuffer` requires, so an odd-length upload can never raise an `OperationError` that the device-loss classifier would mistake for a lost device. The `createBuffer failed … when mappedAtCreation == true` RangeError can no longer come from these uploads.
