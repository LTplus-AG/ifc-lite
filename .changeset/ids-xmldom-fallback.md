---
'@ifc-lite/ids': patch
---

Add `@xmldom/xmldom` as a runtime fallback for environments where the
global `DOMParser` is undefined (Node.js, Web Workers without DOM,
embedded contexts). Browser builds keep using the native `DOMParser` —
the xmldom fallback is loaded dynamically only when needed, so the
browser bundle is unaffected. Also surface fatal xmldom v0.9 ParseError
exceptions as a clear `Failed to parse IDS XML` error instead of letting
them bubble unannotated.
