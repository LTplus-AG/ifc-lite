---
'@ifc-lite/wasm': patch
---

Fix a `site_local`-tier model (an `IfcSite` placement with a non-identity translation, the common case for a model imported with a georeferenced offset) discarding instancing metadata for every mesh even when the site placement carries no rotation. `produce_element_meshes` used to drop `MeshData.instance`/`local_bounds`/`local_to_world` whenever a site-local rotation matrix was present at all; a translation-only site placement never rotates positions (`convert_mesh_to_site_local` already no-ops on an identity rotation block), so the captured transform was never invalidated and the metadata is now kept. A rotated site placement still drops it — extending instancing to that case needs the renderer to instance in the site frame too and is tracked separately (#4118).
