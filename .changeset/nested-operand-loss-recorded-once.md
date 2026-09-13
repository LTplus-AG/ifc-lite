---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

A nested boolean or `IfcCsgSolid` operand that meshes empty because an operand inside it has no mesher is now recorded once. The level above used to add an `EmptyOperand` diagnostic on top of the inner `UnsupportedOperand`, so boolean failure counts were inflated and the reason breakdown named the consequence next to the cause.
