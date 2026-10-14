---
"@ifc-lite/export": patch
---

Export walkers that split, rewrite or scan STEP text (reference remapping and collection, slot splitting, unit rescaling, property-set name and owner-history readers, merged spatial matching) now keep a `\S\` PAGE directive's apostrophe operand inside its string, so a record carrying `'Para \S\' 5'` no longer has its references remapped, its slots shifted or the text after it rescaled.
