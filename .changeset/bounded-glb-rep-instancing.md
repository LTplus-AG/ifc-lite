---
"@ifc-lite/wasm": minor
---

Share repeated shapes in the bounded (streaming) GLB assembler, and stream STEP export.

Above the streaming threshold the assembler used to give up on rep-identity instancing, on the grounds that it "needs every occurrence co-resident". The vertex data does; the decision does not. `collate_refs` reads nothing off a mesh's geometry but its length, so what a group needs is an identity, a placement and a size, and those fit in the plan the bounded path already keeps. Measured on a 1 GB building-services model: glTF 1.83 GB to 710 MB, peak RSS 7.83 GB to 6.70 GB.

Shapes are bucketed by `(rep identity, colour, vertex count, index count)` rather than refused wholesale when one occurrence disagrees about size. On that model 532 groups of 87,393 hold an occurrence clipped to a different vertex count, and between them they hold 22,343 of the 151,282 occurrences — refusing the group for the exception would have cost most of the sharing. f32 output only: a quantized shared mesh carries a non-uniform dequant scale that cannot fold into a rotating placement without breaking `Matrix4.decompose`.

Also adds `export_step_to_writer`, which emits each record as it is read instead of returning the whole file as a `String`. On a 1 GB model that removes a gigabyte of output from the peak. It buffers internally, so a caller passing a bare `File` does not pay two syscalls per record.

Output is byte-identical for models with no shareable shapes.
