---
'@ifc-lite/parser': patch
---

An `.ifczip` compressed on macOS is no longer rejected. Finder writes an
AppleDouble sidecar (`__MACOSX/._<name>`) beside each entry, and it keeps the
original extension, so `__MACOSX/._model.ifc` was counted as a second model and
the archive failed with "contains 2 model files — expected exactly one".

Entries whose BASENAME begins with `._` are now excluded from the model-entry
scan on both the browser and server paths. A genuine second model still fails as
before, and a real model inside a folder named `__MACOSX` is still found.
