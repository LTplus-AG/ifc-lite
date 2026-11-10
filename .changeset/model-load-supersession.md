---
"@ifc-lite/viewer": patch
---

A load you start now takes over from work that was only waiting to load: a federated add still queued for memory, a `?model=` autoload still downloading, a reload resume still reading its cached files, and a background cache revalidation no longer land in, or reload over, the model you opened meanwhile, and a queued add no longer clears that model's error. Composing federated IFCX layers now behaves like any other load: it shows a Cancel and an activity entry, a newer load replaces it, and its layers never land in a newer model's scene.
