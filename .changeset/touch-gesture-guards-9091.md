---
'@ifc-lite/viewer': patch
---

Three touch fixes. A tap that drifts a few pixels before it lifts no longer runs Select, Section face-pick or the command tool a second time from the click the browser sends after it: that click is now ignored over the same 10 px a tap may drift. A trackpad or mouse right-click next to a finger that is still down, or just after a long press, opens the viewer menu again instead of being swallowed. And a thumb resting on a side panel or the toolbar no longer counts as a finger on the 3D view, so taps there still select and a drag follows the current tool.
