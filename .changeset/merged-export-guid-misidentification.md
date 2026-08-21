---
"@ifc-lite/wasm": patch
---

Fix the native (Rust) merged/federated IFC exporter's GlobalId-collision fix
mistaking ordinary model strings for GlobalIds and corrupting them.

`leading_guid` in `rust/export/src/merged.rs` identified an entity's GlobalId
by scanning for the first quoted token anywhere on its STEP line, then
excluding a fixed list of non-`IfcRoot` entity types whose first attribute is
itself a string. Both parts were unsound: a non-rooted entity whose first
attribute is not a string (e.g. `IFCMATERIALLAYER`, whose 4th attribute is
`Name`) could still expose a later quoted string to the scan regardless of
the denylist, and the denylist itself was missing several non-rooted types
(`IFCMATERIALLAYER`, `IFCMATERIALLAYERSET`, and others). When that
coincidentally 22-character, GlobalId-charset string collided with a real
GlobalId already emitted, the exporter silently rewrote it -- corrupting
ordinary model data such as a material layer's `Name`.

GlobalId identification is now positional and type-checked instead: the
quoted token must be the entity's true first attribute (only whitespace
allowed between `(` and the quote), and the entity's type must actually
derive from `IfcRoot`, checked against `rust/core`'s generated schema
(`IfcType::is_subtype_of(IfcType::IfcRoot)`) rather than a hand-maintained
denylist that can drift out of sync with it.
