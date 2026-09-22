---
'@ifc-lite/wasm': minor
---

LandXML units are required consistently, and an assumed unit is auditable (#5175).

A numeric, renderable TIN surface must declare `LandXML/Units` with a `linearUnit`. That rule previously lived only in the streaming session, so the same unitless file refused on one parse path and rendered on the other; it is now one shared check both paths call, and the `LXML009` message names the missing element and attribute. A surface that draws nothing — preserved-only, faceless-refused, or a TIN whose faces are all hidden — still parses without units, unchanged.

`LandXmlParseOptionsJs.assumedLinearUnit` lets a caller supply a unit for a source that declares none, including on `createLandXmlTinStreamSession`. It is opt-in, refuses an unknown token rather than defaulting to meters, and loses to a declared `<Units>` with a warning. Units carry `assumed: boolean` so a consumer can always tell an operator's assumption from the producer's own declaration.
