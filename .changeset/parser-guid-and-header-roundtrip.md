---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
---

Fix deterministic GlobalId first character and STEP header escape round-trip.

`deterministicGlobalId` masked its first output character with the full 6-bit alphabet, but a valid 22-char IFC GlobalId encodes only 2 bits in its first character (128 = 2 + 21*6). The first character is now constrained to `0`-`3`, so a re-stamped federated GUID always decodes to a well-formed 128-bit UUID.

Header string round-trip no longer corrupts ISO-10303-21 escapes: `parseSourceHeader` now decodes `\X2\`, `\X\`, `\S\` and `\Px\` directives to real Unicode (via the canonical `decodeIfcString`) instead of leaving them for the writer's backslash-doubling escaper to mangle (`Tr\X2\00FC\X0\mpler` no longer becomes `Tr\\X2\\00FC\\X0\\mpler`). The shared STEP string escaper (data) also collapses control characters to a space so a header/attribute value can never inject a physical line break.
