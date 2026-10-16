---
'@ifc-lite/wasm': patch
---

Bound allocation and work sized by untrusted input (#7675):

- A LandXML document whose retained source paths (extension roots and preserved-only Corridor/StringLine records) exceed 16 MiB is refused with `retained source path limit exceeded`, instead of holding unbounded memory.
- Repeated root `CoordinateSystem` declarations now produce one counted warning (`LandXML declares N root CoordinateSystem records; retained the last declaration`); the warning text changed.
- An IFC record that fails to parse now reports a short error (offset, the parser's error kind and at most 64 bytes of escaped context) instead of a message several times the size of the record. The text of that error changed.
- `setMaterialLayerIndex` refuses a malformed pre-pass buffer as a whole (a not-sliceable record that carries layers, or layer counts past the layer arrays) and clears the cached index so the caller builds its own, instead of reading another record's layers or sizing an allocation from the wire.
- The sharded geometry pre-pass reports an error to JS, rather than truncating a span, when an entity span does not fit `u32`.
