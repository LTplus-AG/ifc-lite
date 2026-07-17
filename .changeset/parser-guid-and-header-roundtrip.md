---
"@ifc-lite/parser": patch
"@ifc-lite/data": patch
---

Fix deterministic GlobalId first character and STEP header escape round-trip.

`deterministicGlobalId` masked its first output character with the full 6-bit alphabet, but a valid 22-char IFC GlobalId encodes only 2 bits in its first character (128 = 2 + 21*6). The id is now stamped from the hash's 128-bit state MSB-first exactly like `uuidToIfcGuid`'s compression, so it always decodes to a well-formed 128-bit UUID and re-encodes bit-exactly. This also fixes a severe entropy loss in the previous stamping: it read each state word's LOW 6 bits while evolving it with a 32-bit multiply (which never propagates high bits downward), leaving ~24 bits of effective entropy and real collisions at ~10k seeds; the full-state stamping is collision-free across 100k adversarial seeds.

Header string round-trip no longer corrupts ISO-10303-21 escapes: `parseSourceHeader` now decodes `\X2\`, `\X\`, `\S\` and `\Px\` directives to real Unicode (via the canonical `decodeIfcString`) instead of leaving them for the writer's backslash-doubling escaper to mangle (`Tr\X2\00FC\X0\mpler` no longer becomes `Tr\\X2\\00FC\\X0\\mpler`), and collapses the `\\` escape to a single literal backslash first, so `C:\temp` is byte-stable across repeated write/read cycles instead of growing backslashes. The shared STEP string escaper (data) also collapses control characters to a space so a header/attribute value can never inject a physical line break.
