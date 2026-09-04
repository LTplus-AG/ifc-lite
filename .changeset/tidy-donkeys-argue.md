---
"@ifc-lite/server-client": minor
---

Decode the relationships table's new `rel_id` column: `Relationship.rel_id` carries the express id of the `IfcRel*` entity that produced the row. The field is optional and stays `undefined` against a server that does not send the column, so an older server keeps decoding unchanged.
