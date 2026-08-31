---
'@ifc-lite/drawing-2d': minor
'@ifc-lite/viewer': patch
---

The DXF R12 writer's TEXT/layer content mojibaked on any real DXF reader when it contained non-ASCII characters. `DxfWriter.toString()` produces plain ASCII-DXF text declaring `$ACADVER AC1009`, a version with no UTF-8 support (that starts at R2007/AC1021) — but the viewer's DXF download wrote that string out with a UTF-8 encoder (`Blob`'s default string encoding), while a real reader with no declared codepage falls back to `ANSI_1252` (confirmed against `ezdxf`, which mirrors AutoCAD's own default). "Wände" round-tripped as "WÃ¤nde".

The writer now declares `$DWGCODEPAGE ANSI_1252` in its HEADER section, and a new `encodeDxfCp1252` export encodes the document string to the matching windows-1252 bytes (a character outside that codepage, e.g. CJK, becomes `?`, the only representation R12's single-byte TEXT format has). The viewer's section-DXF export now writes those bytes instead of the raw string, and surfaces a toast when a character had to fall back to `?`.

Verified against `ezdxf` (kept out of the repo, per the export-format validation convention `@ifc-lite/export`'s glTF/DXF tests already use): before the fix, a TEXT entity containing "Büro Nr. 3 – Wände östlich" read back as "BÃ¼ro Nr. 3 â€“ WÃ¤nde Ã¶stlich"; after, it reads back byte-correct with zero `ezdxf` audit errors.
