---
"@ifc-lite/create": minor
"@ifc-lite/cli": patch
"@ifc-lite/sdk": patch
---

Compute generated room areas inside joined wall faces and keep their outlines and quantities with moved boundaries in one undo operation. Derive door, window, grid column, stair and curtain wall base quantities; read opening schedule dimensions from OverallWidth and OverallHeight when quantities are absent.

Retain custom room detection settings across reopen, pair gross and net perimeters with their respective areas, reject unsupported quantity derivations, and measure mesh wall thickness perpendicular to its live axis. Opening dimension fallback is shared by schedule and export columns.

SDK CSV/JSON exports also fall back to native opening dimensions when quantities are absent, while keeping explicit quantities. Retain an explicitly zero room snap tolerance during boundary updates.
