---
"@ifc-lite/viewer": patch
---

Vector PDF export now places justified DXF reference text (TEXT alignment, MTEXT attachment) along its rotated baseline. jsPDF shifted centred, right, top, middle and bottom text along the page axes instead, so rotated labels landed beside their alignment point.
