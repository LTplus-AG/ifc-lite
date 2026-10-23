---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

LandXML (#7693): an `assumedLinearUnit` now applies to every family a source carries, not only its TIN. A unitless plan, alignment or pipe network gets the assumed unit (flagged `assumed: true`) instead of no units, and a unitless pipe network is no longer refused with "pipe-network element requires Units". `LandXmlPipeUnitsJs` gains `assumed`, true only for root units built from the assumption; the viewer keeps it on its pipe-units record. An unknown token is refused by the plan, alignment and pipe parsers too.

The numeric checks were also aligned. A parcel arc is checked with the same relative radius and length tolerances as an alignment `Curve`, so real producer arcs at georeferenced coordinates are measured instead of being kept preserved-only. A `CircCurve` may declare its arc length or its horizontal length, and a crest's radius may be written negative, as 3D-Win does. A probe at the end of an `IrregularLine` whose declared length is slightly longer than its polyline now returns the authored end instead of an error. An XML declaration can no longer hide an unsupported encoding by padding the first 1024 bytes so they end inside a character. A TIN face that repeats a vertex is kept as authored and reported in the document's warnings.
