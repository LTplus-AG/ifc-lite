---
"@ifc-lite/encoding": minor
"@ifc-lite/viewer": patch
---

`@ifc-lite/encoding` adds `uuidV5(namespace, name)`. It computes the RFC 9562 name-based (version 5) UUID synchronously and matches the RFC test vector and the `uuid` package.

The viewer's Split tool now follows one identity policy for walls, beams, columns, members, slabs, roofs, plates and spaces (#6233):

- The larger piece keeps the source element: express id, GlobalId, relationships, and the openings still inside it. It is reshaped in place.
- One new element takes the other piece. Its GlobalId is the v5 UUID of `<sourceGlobalId>/split/<k>`, probed past ids that already exist.
- The whole split is one undo step.
