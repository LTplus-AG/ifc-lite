---
"@ifc-lite/collab-server": minor
---

Durable layer registry: `FsLayerRegistry` persists content-addressed layers, refs (with policies), and review objects to disk under the collab data dir, so a registry survives restarts. The deployed binary mounts it with `COLLAB_LAYER_REGISTRY=1`. Shared push-integrity gate extracted as `assertPushableLayer`.
