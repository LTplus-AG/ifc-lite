---
"@ifc-lite/export": patch
---

An IFC2X3 → IFC4 or IFC4X3 export now leaves out a legacy date record (`IfcCalendarDate`, `IfcLocalTime`, `IfcDateAndTime`, `IfcCoordinatedUniversalTimeOffset`) that nothing references, even when no slot converts a date. Before, such a record was written verbatim against the new header with a "readers may reject" warning. Each omitted record is named in the export warnings (`#2 (IFCCALENDARDATE) was omitted because nothing references it …`) and in the conversion loss report. A date record still referenced by an unconverted slot is kept and reported, as before. A clock whose minute or second the source left unset is still written with `00`, and the export now names each such slot in a warning.
