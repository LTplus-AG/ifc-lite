---
"@ifc-lite/viewer": minor
---

Add a "Save Markup to Model" action to the 2D drawing panel's toolbar and overflow menu (issue #4153). It writes the current drawing's measurements, area annotations, text notes and revision clouds into the active model's edit overlay as tagged `IfcAnnotation` entities, so they ride along the next Export Changes / Export click — the action itself does not write to disk, and its confirmation toast says so explicitly. Pressing it again replaces the previous save rather than duplicating annotations, and pressing it with no markup drawn clears any previously-saved markup from the overlay.

When a model is loaded, its markup arrays are also restored from any tagged annotations the file already carries (a model previously saved into and re-opened). Restore never overwrites markup another source (a user drawing, or a future `localStorage`-based restore) already populated for the same model this session.
