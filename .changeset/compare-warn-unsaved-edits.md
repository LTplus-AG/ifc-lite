---
"@ifc-lite/viewer": patch
---

Compare now warns when either compared model has unsaved viewer edits: the data channel reads the parsed store, not the mutation overlay, so an edited-but-unsaved model was silently compared as loaded from disk with no indication to the user. This is the warn-only half of the issue (#5214 finding 2); Compare still does not read the overlay.
