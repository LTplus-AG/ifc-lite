---
'@ifc-lite/viewer': patch
---

Fix three defects in the multi-click polyline measurement mode found by adversarial review:

- Switching away from the Measure tool with a polyline sequence in progress (or a drag mid-flight) no longer strands it. `setActiveTool` now clears the in-progress gesture whenever it leaves `'measure'` — the only way `MeasureOverlay` ever unmounts, since it is gated purely on `activeTool === 'measure'`. Switching back to Measure always starts clean.
- Finishing a polyline with a physical double-click no longer appends a spurious near-duplicate vertex. Browsers dispatch `click, click, dblclick` for one gesture; `finishPolyline` now drops a trailing point that lands within a couple CSS px of the previous one before validating/recording, the same fix `SpaceSketchOverlay`'s polygon tool already applies to its own double-click-to-close gesture.
- Pressing Enter (or double-clicking) on a 1-point sequence — too few points to finish — now shows an error toast instead of doing nothing silently. The sequence is left in progress rather than cancelled, matching how the AddElement polygon tool handles the same too-few-points case.
