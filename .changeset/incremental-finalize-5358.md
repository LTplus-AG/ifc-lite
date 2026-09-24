---
'@ifc-lite/renderer': patch
---

Make a streaming finalize rebuild only what was streamed since the last finalize (#5358). `Scene.finalizeStreaming()` and `finalizeStreamingAsync()` used to dissolve and rebuild every bucket in the scene, so each streamed federated add re-merged and re-uploaded the whole federation (O(N²) over N models) and briefly held two GPU copies of all of it. They now re-group and rebuild only the buckets that received streamed meshes (plus any key already pending). Every other model keeps its batches, its partial-visibility caches and its residency state. The streamed meshes are still re-grouped by their current colour, so deferred style colours applied during streaming still land in the right batch. On a failed GPU upload the bucket map is restored along with the drawables.
