---
"@ifc-lite/renderer": minor
---

`replayReleasedGeometry(renderer, batches, { signal, isCurrent })` rebuilds a scene whose CPU geometry was released after upload (#10264). The host streams its stored flat meshes back in batches. Each batch is uploaded through the ephemeral streaming path, which keeps GPU fragments only, so peak CPU memory is one batch. Per-entity world bounds and per-model placement bounds are kept as the batches pass, so picking, framing and placement keep working. Between batches the replay checks `isCurrent` and the device. A superseded, cancelled or device-swapped replay still finishes the ephemeral pass, so the scene stays consistent and released, but its result says `superseded`/`cancelled` so the host replays again. `unavailable` means there is no device or pipeline. Nothing changes for scenes that keep their CPU geometry.
