---
"@ifc-lite/viewer": patch
---

`useAnnotation2D`'s hit-test now walks each annotation type in reverse array order and checks types in the reverse of `Drawing2DCanvas`'s paint order — cloud, then text, then polygon, then measure — so the annotation drawn on top is the one a click selects. Previously the hit-test always checked text first, then cloud, polygon, measure, each forward through its array (oldest first): a cloud drawn over an older text box, or a newer cloud drawn over an older one at the same spot, could have its click intercepted by the annotation underneath — so a delete could remove the wrong one. `useAnnotation2D.hitTestOrder.test.tsx` pins both a same-type overlap (newer cloud wins over an older one) and a cross-type overlap (a cloud over a hidden text box selects the cloud). The hook had no dedicated test file before this change.
