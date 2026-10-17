---
'@ifc-lite/wasm': patch
---

`parseLandXmlSourceBytes`, `parseLandXmlSourceBytesWithOptions` and `parseLandXmlTinBytes` read the LandXML bytes once for every family (they used to decode, scan and parse them three or four times). `parseLandXmlSourceBytesWithOptions` now also returns the document's pipe networks (`tin.pipe_networks`), as `parseLandXmlSourceBytes` always did. No signature changes.
