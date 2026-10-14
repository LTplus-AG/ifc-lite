---
"@ifc-lite/export": patch
---

Export walkers that split, rewrite or scan STEP text (reference remapping and collection, slot splitting, unit rescaling, property-set name and owner-history readers, merged spatial matching) now keep a `\S\` PAGE directive's apostrophe operand inside its string, so a record carrying `'Para \S\' 5'` no longer has its references remapped, its slots shifted or the text after it rescaled.

The property-set and element-quantity name readers (`getPropertySetName`, `getElementQuantityName`, and the Rust `property_set_name`) also read a name that holds a doubled apostrophe whole. `'It''s'` used to come back as `It` and now comes back as `It''s`, the raw STEP text, undecoded as before, so a set named "It" is no longer confused with it.
