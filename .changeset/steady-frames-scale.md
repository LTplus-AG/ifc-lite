---
"@ifc-lite/viewer": patch
---

Keep a scaled document block inside the printable frame and keep the preview and the PDF in step. A chart with a snapshot no longer prints into the footer when it is drawn at 200 % on a landscape page, two half-width charts that fill the frame stay one row at every block size instead of splitting at some of them, an image with no title or caption is clamped to the page in the preview as it is in the PDF, and a typed block size such as 120.5 is stored as the whole percent the field shows.
