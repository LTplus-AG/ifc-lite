---
"@ifc-lite/bcf": patch
"@ifc-lite/export": patch
---

Write ZIP archives with "version needed to extract" 2.0 on DEFLATE entries, as the ZIP APPNOTE requires. JSZip hardcodes 1.0 on every entry, so `writeBCF` (.bcfzip) and `ParquetExporter.exportBOS` (.bos) now pack with fflate, which writes 2.0 itself. Found while investigating #3612; this is not shown to be the cause of the Solibri import failure reported there.
