---
"@ifc-lite/wasm": patch
---

LandXML import now resolves character and entity references in element text (#7680). `<P id="1">1&#46;5 2 3</P>` reads northing 1.5; it was read as 15 because the reference was silently dropped. An undeclared entity such as `&custom;` in text is refused with `EntityForbidden`, as it already was in attribute values, and text references now count against `max_character_references`. The streamed import (`createLandXmlTinStreamSession`) no longer falls out of step after such a reference, which refused valid files as "unclosed XML element", and it now refuses a reference outside the root element, as the whole-file parse does.
