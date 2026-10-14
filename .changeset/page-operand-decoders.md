---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Attribute decoders now keep a `\S\` PAGE directive's apostrophe operand inside its string, so an entity whose Name is `'Para \S\' 5'` decodes ("Para § 5") instead of failing, and its later attributes (Representation, relationship references) are read from the right slots.
