---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

Retained geometry (opt-in, #7955): the retained session no longer reads the whole file a second time to join authored metallic/roughness. `ifc-lite-processing` adds `ModelFinishes::from_source`, which joins finishes from the candidate scan's styled-item spans and the source's own entity index, so a large model's browser heap no longer carries a second per-entity index (on a 177 MB model, the finish join holds 38 MB instead of 143 MB). The finishes it joins are the ones the rescan joined. The default exact path and its output are unchanged.

In the viewer, a model loaded with the retained kernel exports GLB from the meshes the viewer holds instead of re-meshing its file with the exact engine, so the GLB is the geometry on screen. USD and the energy models (HBJSON, DFJSON) can only re-mesh the file, so their commands are disabled with a reason on a retained model, and the IFC5 output refuses an incomplete retained model as the GLB, KMZ and USD commands already did. Models loaded with the exact kernel are unaffected.
