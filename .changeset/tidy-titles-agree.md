---
"@ifc-lite/viewer": patch
---

A block heading whose size or strip you change is now drawn the same in the preview and the PDF, and stays inside its strip. A topic's own title and the not-loaded notice are cut to the text column in the PDF instead of running into the snapshot or off the page, and the preview heading stays on one line instead of wrapping over the content below it. The preview heading is the PDF's 11 pt until you change it, so raising the size no longer makes it shrink first, and choosing only a background no longer moves the content. A chart's heading strip spans the same width as every other block's. The three heading controls are now named "Title size", "Title colour" and "Title background", apart from the table's "Header background" and "Header text".
