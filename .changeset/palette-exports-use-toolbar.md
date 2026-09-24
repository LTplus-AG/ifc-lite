---
"@ifc-lite/viewer": patch
---

Command palette exports now go through the same dialogs and handlers as the toolbar and ribbon (#5601). The palette's Export category is built from the toolbar's export list, so it now offers IFC, KMZ, Energy and PDF too. GLB, USD and the anonymized subset open their export dialogs. A failed export shows an error toast instead of only logging to the console, running an export with nothing loaded says so, and Screenshot captures the 3D viewport rather than whichever canvas comes first on the page.
