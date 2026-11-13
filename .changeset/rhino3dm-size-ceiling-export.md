---
'@ifc-lite/rhino3dm': minor
'@ifc-lite/viewer': patch
---

`@ifc-lite/rhino3dm` exports `MAX_3DM_BYTES` and `tooLarge3dmMessage`, from a module that imports nothing, so a caller can check the size cap on the main thread without loading rhino3dm. The viewer uses them for its pre-copy check instead of a copy of the number and sentence. The refused size now rounds up: a file just over the cap read "This file is 400 MB; the reader handles up to 400 MB", and now reads 401 MB.
