---
"@ifc-lite/renderer": patch
---

Hiding or isolating elements while a model is still streaming no longer blanks parts of it. A streaming fragment now carries its owning bucket's key, so its partial (hide/isolate) batch finds its pieces when that key is more than the bare colour: any federated model after the first (`model<i>~`), entity ids past 2^24 (`p<n>~`), and overflow buckets (`#N`). Before, the isolated element and its same-colour neighbours were not drawn until streaming finished.
