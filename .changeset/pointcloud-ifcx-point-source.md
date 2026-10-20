---
"@ifc-lite/pointcloud": minor
---

Add decodeIfcxPointSource for authored IFCX numeric channels before float32 staging, preserving ASCII and binary float64 PCD and inline array precision through shared codecs. Existing chunk decoders retain their float32 outputs, validation, offsets, and bounds.
