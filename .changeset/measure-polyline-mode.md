---
'@ifc-lite/viewer': minor
---

Add a multi-click polyline measurement mode to the Measure tool, alongside the existing drag-to-measure distance gesture.

A new "Polyline" toggle in the Measure panel switches the tool from the original drag (A to B) gesture to accumulating points via successive clicks. Double-click or Enter finishes the sequence as an open polyline (reports the sum-of-segments length); clicking back near the first point (once at least 3 points are placed) closes it into a loop instead, reporting the perimeter (the same sum plus the closing segment). Escape cancels an in-progress sequence without recording anything. The panel always prints which basis a number was computed under ("Length" vs. "Perimeter (closed)") rather than leaving it implicit.

The two gestures are mutually exclusive by construction: switching modes cancels whichever gesture was in progress in the mode being left (`setMeasureMode` in `measurementSlice.ts`), and polyline mode never starts a drag measurement (`shouldStartDragMeasurement` gates `mousedown` in `useMouseControls.ts`) — the original drag-to-measure flow is unchanged.

This is the first consumer of the mode; distances continue to route through the existing `formatDistance`/`resolveQuantityDisplay` unit-display path, honouring the same `unitDisplayOverrides`. Neither toolbar hosts any of this UI — it lives entirely in the shared Measure panel, per the existing `measure-parity.test.tsx` guard.

Deliberately out of scope for this change: free-polygon/rectangle area, three-point angle, minimum distance, diameter/radius, and circle-centre snapping — each still needs either mesh analysis reachable from TypeScript or its own interaction beyond the polyline primitive shipped here.
