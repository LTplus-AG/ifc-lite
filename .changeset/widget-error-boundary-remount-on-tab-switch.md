---
'@ifc-lite/viewer': patch
---

Fix a crashed extension widget masking every widget viewed afterward in the same dock slot.

`WidgetErrorBoundary` never cleared its caught error, and `ExtensionDockHost` rendered it (and its `DockBody` parent) without a `key`, so switching the active dock tab reused the same React instance. Once any widget in a dock slot threw during render, every subsequently-viewed widget in that slot showed the first widget's stale crash banner instead of its own content — the panel effectively froze until it fully unmounted.

`DockBody` and `WidgetErrorBoundary` are now keyed on the widget's identity (`extensionId`/`widget` path), so switching tabs discards the crashed instance and mounts a fresh one; re-rendering the *same* widget keeps the same key, so a widget that throws on every render still shows its own crash and does not enter a remount/crash retry loop.
