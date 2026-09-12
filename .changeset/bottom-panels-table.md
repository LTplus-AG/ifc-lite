---
"@ifc-lite/viewer": patch
---

The bottom strip (Schedule / Script / Lists) is table-driven: `lib/panels/bottom-panels` owns the id list, the store flags and the precedence rule, and the store actions, layout (`BottomStrip`), mobile sheet, panel controls, command palette and tour snapshot derive from it instead of each spelling the trio out by hand. The overlay compositor (`useOverlayCompositor`) is mounted once by `ViewerLayout` for the whole session rather than by the Gantt panel, so an overlay layer registered by any panel is composited by exactly one writer. No user-visible change; groundwork for the charts panel (#3944).
