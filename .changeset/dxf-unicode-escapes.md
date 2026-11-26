---
"@ifc-lite/drawing-2d": patch
---

Write characters outside windows-1252 in DXF text (Romanian, Czech, Polish and other BMP letters) as `\U+XXXX` escapes instead of `?`, and spell a literal backslash before `U+` as `\U+005C`. `encodeDxfCp1252` gains `hadEscaped`; `hadUnmappable` now reports only what is still lost (astral code points such as emoji).
