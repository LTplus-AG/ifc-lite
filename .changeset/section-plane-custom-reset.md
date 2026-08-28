---
'@ifc-lite/viewer': patch
---

Fix a session reset (loading a new primary file) leaving the section tool's face-picked custom plane in place.

`sectionSlice`'s teardown reset `axis`/`position`/`enabled`/`flipped` to their defaults but left `custom` untouched. `custom` (`normal`, `distance`, `pickedAt`, `tangent`, `bitangent`) is absolute world-space geometry read off the outgoing model's coordinate frame — strictly more model-relative than the four fields the reset already cleared. Face-picking an arbitrary-normal section plane and then loading a different file kept the old model's cut plane instead of arming face-pick mode for the new one.

The teardown now rebuilds `sectionPlane` from its defaults on every session reset and carries forward only the three fields that round-trip through localStorage (`showCap`, `showOutlines`, `capStyle`), instead of spreading the live plane and overwriting individual session-scoped fields by name. A future session-scoped field on `SectionPlane` therefore defaults to cleared on reset unless it is deliberately added to that keep-list.
