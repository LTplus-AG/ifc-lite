---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Gaussian captures keep far less memory (#9018). The renderer no longer keeps a CPU copy of a capture's rows after upload: the GPU holds the packed rows, and the CPU keeps only the centres, opacities and asset slots the depth sort and clipping read (20 bytes per splat instead of 484). Adding or removing a capture copies the other captures' rows on the GPU. A placement edit, a change of SH layout and device-loss recovery read the rows again from the capture's source. Higher-order SH coefficients are stored on the GPU as half floats when every coefficient fits (worst-case colour error below half an 8-bit step on real captures), otherwise as float32. `GaussianSplatApi.add` accepts `rows`, a re-readable `GaussianRowSource`; `gaussianRowsFromAttributes` builds one over arrays the caller keeps, and `attributes` is still accepted as shorthand for it. The viewer streams a capture from its decoder worker in bounded slices instead of holding the whole decode on the main thread.
