---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Schema conversion between IFC2X3 and IFC4/IFC4X3 keeps the link between a document and its references (#10846). An upgrade writes each reference listed in IFC2X3 `IfcDocumentInformation.DocumentReferences` into the reference's IFC4 `ReferencedDocument`, so a valid IFC2X3 source gives output that passes `IfcDocumentReference.WR1`. WR1 allows a Name or a ReferencedDocument, not both, in IFC2X3 too, so a listed reference with a Name comes only from an invalid source: its upgrade drops the Name. A reference identified only by its Name keeps it and is not linked, since IFC4 needs a Location, Identification or Name. Both cases are reported, and the loss preview lists the dropped Names. A downgrade collects the references back into `DocumentReferences`. A reference listed by two documents keeps the first, and the second listing is reported. The conversion loss report no longer lists a link the export moves. Like the structural prepasses, this needs an unedited full single-model export. A merged export does not arm it.
