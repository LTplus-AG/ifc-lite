---
"@ifc-lite/wasm": patch
---

A wall or slab is no longer left with an open hole next to an opening that does not actually reach it (#5362). When the exact cut finds that an opening and its host do not overlap (for example an opening that ends flush on the wall face, placed more than about 32 m from the origin), the rectangular fallback cut no longer removes the host faces under the opening's bounding box. Across the public fixture corpus, 28 hosts improve and 25 of them are now closed, and their volumes match IfcOpenShell.
