---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Schema conversion between IFC2X3 and IFC4/IFC4X3 keeps the link between a document and its references (#10846). An upgrade writes each reference listed in IFC2X3 `IfcDocumentInformation.DocumentReferences` into the reference's IFC4 `ReferencedDocument`, so a valid IFC2X3 source gives output that passes `IfcDocumentReference.WR1`. A downgrade collects the references back into `DocumentReferences`. A reference listed by two documents keeps the first, and the second listing is reported. The conversion loss report no longer lists a link the export moves. Like the structural prepasses, this needs an unedited full single-model export. A merged export does not arm it.
