---
'@ifc-lite/lists': patch
---

A World Coordinate column whose axis is not `X`, `Y` or `Z` now resolves to an empty cell instead of silently reporting the X coordinate.

`getWorldCoordinateValue` matched the axis with `case 'X': default: return pos.x;`, so the explicit `X` case and the fallback shared a body. Any other axis — a hand-edited saved list definition, a definition written by a build that knows an axis this one does not — got the X coordinate under a header saying something else. A blank cell is a visible gap; a plausible number under the wrong label is a wrong answer that reads as a right one, and nothing downstream can tell the two apart.

Blank or whitespace-only still means `X`, which is the documented default for a column created without an axis. Whitespace-only is treated as absent rather than as an unknown axis, matching how a blank name is handled elsewhere.

No existing column changes: the Lists builder offers only `X`, `Y` and `Z` (`ListBuilder.tsx`), so no axis a user can pick today is affected. The change protects persisted definitions and forward compatibility.
