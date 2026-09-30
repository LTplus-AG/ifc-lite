---
"@ifc-lite/viewer": minor
---

Change sets panel (#6232 D4). A change set is a named group of edits. Every edit now lands in the active change set; the first edit with no active set starts one called "Unsaved changes". Undo takes an edit out of its set and redo puts it back in the same set. The panel (Author ribbon, the Model workspace rail, or "Change sets" in the command palette) lists each set with its creation time and edit count, creates, renames and activates sets, shows a set's edits grouped by element (a click selects the element), exports a set as a `.changeset.json` file, imports one back, and discards a set after asking. Discarding a set removes only its list of edits; the edits stay in the model.
