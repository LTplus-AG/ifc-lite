---
"@ifc-lite/renderer": minor
---

Add `Renderer.recoverDevice()` and typed `DeviceRecoveryResult` APIs to rebuild a lost WebGPU device and reconstruct the CPU-backed scene in place. Flat and instanced IFC geometry, textures, model placement, selection, visibility, colour overrides, camera state, and quantized-pipeline preference survive recovery; unsupported GPU-only scenes fail explicitly, while point clouds, reference images, and transient overlays are returned as omissions for the host to reload (#4885).
