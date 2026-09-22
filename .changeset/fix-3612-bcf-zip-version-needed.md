---
"@ifc-lite/bcf": patch
---

Fix `writeBCF` writing ZIP entries with "version needed to extract" set to 1.0 (JSZip's hardcoded value) while using DEFLATE compression, which the ZIP APPNOTE requires 2.0 for. Found while investigating #3612; whether this explains the import failures reported there is not established.
