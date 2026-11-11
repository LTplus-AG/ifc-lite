---
"@ifc-lite/wasm": patch
---

Exact CSG predicates run faster in the WebAssembly engine. Most multiplications in the exact predicate tier have operands of one or two 64-bit limbs, and the wasm build now multiplies those without the scratch buffers its general digit-by-digit routine needs. The products are the same integers, so geometry output is unchanged; models with many openings and boolean cuts process their geometry about 1–2% faster.
