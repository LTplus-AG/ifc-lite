---
"@ifc-lite/wasm": minor
---

Share repeated shapes in the bounded (streaming) GLB assembler, and stream STEP export.

Above the streaming threshold the assembler used to give up on rep-identity instancing, on the grounds that it "needs every occurrence co-resident". The vertex data does; the decision does not. `collate_refs` reads nothing off a mesh's geometry but its length, so what a group needs is an identity and a placement, and those fit in the plan the bounded path already keeps.

Measured on a 1.05 GB building-services model, 320,688 elements, same machine and same binary shape either side:

| | before | after |
|---|---|---|
| glTF | 1.82 GB | 1.14 GB |
| meshes | 226,506 | 109,236 |
| triangles | 32,273,344 | 19,778,131 |
| peak RSS | 6.02 GB | 5.36 GB |
| wall | 16.20 s | 15.95 s |

Grouping follows `collate_refs` exactly: a rep identity whose occurrences disagree about vertex or index count goes out flat, all of it. That refusal is a safety property rather than an oversight, because `rep_identity` is only the RepresentationMap entity id for a mapped item, so two occurrences of one map clipped differently but landing on the same counts are a group whose members are not one shape.

f32 output only. A quantized shared mesh carries a non-uniform dequant scale that cannot fold into a rotating placement without breaking `Matrix4.decompose`, so quantized output still goes out flat.

Also adds `export_step_to_writer` to the `ifc-lite-export` Rust crate (it is not exposed through the wasm bindings, so npm consumers cannot call it), which emits each record as it is read instead of returning the whole file as a `String`. On a 1 GB model that removes a gigabyte of output from the peak. It buffers internally, so a caller passing a bare `File` does not pay two syscalls per record.

Output is byte-identical for models with no shareable shapes.
