---
"@ifc-lite/renderer": patch
---

Fix GPU memory + validation-scope leaks in the WebGPU renderer.

- Partial sub-batch clones built during hide/isolate are now released when the filter returns to fully-visible (`Scene.dropAllPartialCaches`), instead of staying resident (~2x model VRAM) until the next model reload.
- Hydrated pick/selection individual meshes are freed on selection change (`Scene.disposeHydratedMeshesExcept`), so they no longer accumulate in VRAM or double-alpha-blend transparent geometry (glass darkening) over their batch copy. Disposal is keyed by the (modelIndex, expressId) pair, so selecting the same express id in a different federated model frees the previous model's mesh too.
- Per-frame O(total-element-count) work under hide/isolate is cached by a visibility-version epoch: per-batch visibility + visible-id sets are computed once per visibility change, and `getOrCreatePartialBatch` skips its per-frame sort + FNV hash on a cache hit. Change detection is by set CONTENT (not reference), so callers that mutate the same `hiddenIds`/`isolatedIds` Set in place stay correct, and a fresh Set with identical content does not force a cache rebuild; the instanced-occurrence visibility path uses the same contract.
- Every `pushErrorScope('validation')` is now balanced by a `popErrorScope` on all render paths (null current-texture early-return and thrown frames included), so a leaked scope no longer silently swallows later validation errors and blinds `getDiagnostics().gpuErrors`.
- `Renderer.destroy()` now calls `GPUDevice.destroy()`, so apps that recreate a renderer per model no longer leak the device/queue/context (the lost-handler already ignores the intentional `'destroyed'` reason).
