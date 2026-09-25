---
"@ifc-lite/viewer": patch
---

Toasts no longer bury the viewer when something fails repeatedly (#5603). Identical messages merge into one toast with a count (×5) instead of stacking, and at most three toasts show at once, the oldest giving way. Errors stay until you dismiss them rather than vanishing after five seconds, and screen readers now hear them assertively; the live regions stay mounted so the first toast is announced too. The dismiss button has an accessible name, and info toasts use the info icon instead of a download arrow.
