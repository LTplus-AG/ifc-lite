---
'@ifc-lite/export': patch
---

Convert every record a converting STEP export appends, and refuse what cannot be written (#7682).
- **Appended records are converted like source records.** These are the regenerated property sets and their relationships, the type objects whose `HasPropertySets` is repointed, and the new georeferencing records. They now go through the same schema conversion as the source records. They used to reach the file in the source schema's shape. An IFC4 `IfcDoorType` exported to IFC2X3 is now written as `IfcDoorStyle`, and generated records take part in the IFC2X3 slot fill.
- **A created entity that reuses a source record's id refuses the export** ("created entity #N reuses source id #N"). Such a log was written against another file. The writer used to put the id in the file twice.
- **A repeated express id in the source is written once.** The writer keeps the last record with that id, the one ifc-lite's readers resolve it to, and warns about each earlier one. It used to write every record.
- **A created entity whose class is not an IFC entity name refuses the export.** Such a class would otherwise be written as the record's keyword verbatim.
- **Allocating an express id past `u32::MAX` refuses the export.** No ifc-lite reader can read such an id back.
