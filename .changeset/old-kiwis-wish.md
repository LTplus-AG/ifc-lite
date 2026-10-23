---
"@ifc-lite/wasm": major
---

Symbolic extraction reports cancellation and resource refusal instead of returning an empty success. Both IfcAPI symbolic methods now throw on a terminal stop; successful collection shapes stay unchanged. Breaking low-level ABI: exported InitOutput.ifcapi_parseSymbolicRepresentations changes from three numeric arguments returning a number to four numeric arguments returning void. Use IfcAPI.parseSymbolicRepresentations(content), whose signature remains unchanged, instead of calling that raw WASM export.
