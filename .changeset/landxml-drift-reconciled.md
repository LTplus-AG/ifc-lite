---
'@ifc-lite/wasm': patch
---

LandXML parsing refuses two inputs the terrain parser used to accept: a numeric field (`<P>`, `<F>`, a point list) with a child element inside it, which was read as the text around the element, and a character reference to a non-XML character such as `&#0;` or `&#xFFFE;`. The terrain, plan, alignment and pipe readers and the streaming session now report one text for a second root element, an unsupported version, an empty document and an unclosed document, and alignment resource limits report `LXML004` instead of `LXML009`.
