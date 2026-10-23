---
"@ifc-lite/wasm": patch
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. New `plan::execute` writes an edited copy of an existing IFC file from a typed plan: per object, preserve it, delete it (repairing every relationship that named it), or patch it (rename, property and quantity writes in the file's units, placement moves and rotations). A shared property set or value is copied before it is changed, never edited in place. Anything the executor cannot do is reported as a refusal. The output keeps the source schema, is streamed in file order, and each written record is validated as it goes.
