---
"@ifc-lite/viewer": patch
---

Fixed a clash revision baseline save that could hit the browser storage quota and fail on a large federated model. `saveRevisionBaseline` now strips the per-rule `matchedKeysA`/`matchedKeysB` key lists (added for #3947) before persisting, since the revision-compare read path never consults a stored baseline's own matched keys — only its match counts and clash count. Saving a baseline is smaller and less likely to hit quota; the coverage counts shown in the compare dialog are unaffected.
