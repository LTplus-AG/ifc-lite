---
'@ifc-lite/viewer': patch
---

Measure: three keyboard fixes in the Measurements list. Enter on a focused button presses that button, so Enter on Cancel (✕) cancels an open Polyline or Radius instead of finishing it, and Enter on a row's delete button deletes that row; Enter in the 3D view still finishes. Deleting a row from the keyboard moves focus to the next row, else the previous one, else the list, instead of dropping it on the page; every recorded row (distance, polyline, angle, radius) is now a focus target named by its label and value. One Esc on a focused Finish or Cancel cancels the sequence; it used to take two, because the button's tooltip took the first. Elsewhere the first Esc still only closes a tooltip.
