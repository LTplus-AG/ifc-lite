---
"@ifc-lite/create": minor
"@ifc-lite/viewer": minor
---

Copy, paste and array in the Model workspace (#6232 C3). Ctrl+C copies the selected elements, Ctrl+V pastes them at the cursor (snapped) on the current storey and Ctrl+Shift+V pastes them in place, so a copy moves to another storey by switching storey first. Array (rail, Shift+A) repeats the selection in a row (spacing, or fit to the clicked distance) or around a centre. Every paste and every array is one undo step. Copies get fresh GlobalIds, and the openings, doors and windows of a copied wall come with it, with new void and fill relationships. `@ifc-lite/create` exports `copyProductInStore`, `createCopyContext`, `copyRefusal` and `productStoreyOrigin` for this. `resolveDuplicateSource` now reads elements created in the session and writes the duplicate's Representation as a reference, where a duplicate of a file element used to carry it as a bare number.
