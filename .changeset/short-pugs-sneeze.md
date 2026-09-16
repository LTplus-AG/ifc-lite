---
"@ifc-lite/viewer": minor
---

Reposition models can now rotate a model about the workspace vertical axis. Enter an absolute heading in degrees with an optional pivot point (defaulting to the model's bounds centre and shown, not implied); the rotation is applied before the placement offset, joins moves on the same undo stack, survives export/import of the placement manifest, and is baked into the model's geometry so the viewport, picking, bounds, spatial queries and graphical exports all read one set of coordinates. Records saved before rotation existed load as unrotated. Pointclouds are refused rather than half-rotated.
