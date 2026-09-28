---
'@ifc-lite/viewer': minor
---

Add the History panel: a model's version history from a commit-aware source (contract 2.1.0).

Open any past version read-only, compare any two versions — counts and a grouped change list arrive from one request, with no model loaded — hand the pair to the existing Compare panel for the 3D overlay, and see one element's history in the properties panel, following it through a re-GUID rather than showing it born on the day it was renamed.

A past version is read-only everywhere: `canEditModel` replaces the collab-role gate on every mutation writer, so a refused edit leaves no undo entry and no dirty flag. "Open (replace)" swaps the model only after the replacement has loaded, carrying over the user's model tags, the active model and the selection — by GlobalId, because express ids are reassigned by every re-export.

A revision-only source (Dropbox, Microsoft 365) gets a linear timeline from its existing `listRevisions`, with Open disabled and the reason given where historical bytes cannot be fetched.
