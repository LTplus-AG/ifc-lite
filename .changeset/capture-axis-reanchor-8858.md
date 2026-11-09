---
'@ifc-lite/viewer': patch
---

Changing a survey-scale Gaussian capture's source up-axis re-anchors its renderer asset when its new centres exceed the previous anchor range. An explicit `gaussianPlacement` saved before #8778 that already included the IFC origin shift must have that baked shift removed before reopening, because the viewer now subtracts the shared frame itself.
