---
"@ifc-lite/collab": patch
"@ifc-lite/collab-server": patch
"@ifc-lite/renderer": patch
---

Link-based multiuser collaboration plumbing (ports draft #937):

- `@ifc-lite/collab`: STEP → IFCX room seeding (`seedFromStep`), entity placement
  helpers (`usd::xformop` read/write + baselines), shared annotation pins,
  multi-mesh geometry refs (`geomIds` with legacy `geomId` read fallback,
  `addGeometryRef`, `iterGeometries`), presence `role` field, and a browser fix
  for `HttpBlobStore` (bind global `fetch` to avoid "Illegal invocation").
- `@ifc-lite/collab-server`: signed room tokens (HS256 mint / verify / revoke /
  kick endpoints + `createRoomTokenAuthenticator`), CORS for the HTTP routes,
  disk-backed `FsBlobStorage`, `Room.kickClient` / `RoomManager.peek`, and a CLI
  that wires token auth + disk blobs from `COLLAB_TOKEN_SECRET` /
  `COLLAB_DATA_DIR` (plus a reference Dockerfile + railway.toml).
- `@ifc-lite/renderer`: `rotateMeshesForEntity/-Entities` — in-place yaw rotation
  of an entity's flat meshes about a pivot (local-frame-origin aware), used by
  live collab placement sync and the viewer's rotate action.
