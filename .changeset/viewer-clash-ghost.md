---
"@ifc-lite/viewer": minor
---

Clash review now has an **X-Ray "Ghost" context** mode (#1275). The "On select"
control offers Highlight / Isolate / **Ghost**: Ghost keeps the clashing pair
solid and fades the rest of the model to translucent context, so a clash can be
judged in place without hiding its surroundings. Wires the renderer's
`ghostExceptIds` through a new `ghostExceptEntities` visibility channel.
