---
"@ifc-lite/data": minor
"@ifc-lite/mutations": patch
---

Add `iterateEffectiveEntities`, the single effective-entity enumeration for a live model session (#5249). Given a store's entity index and its mutation overlay, it yields every source entity except tombstoned ones and every overlay-created entity, with its effective class (retypes applied) and an `overlayCreated` flag. The overlay can be a `MutablePropertyView` or any object with the same `isDeleted`/`getNewEntities`/`getTypeMutations` shape, such as a worker snapshot. It lives in `@ifc-lite/data` so that packages which do not depend on `@ifc-lite/mutations`, such as IDS, can use it. `@ifc-lite/mutations`' `iterateEffectiveEntityIds` now delegates to it, with the same signature and results.
