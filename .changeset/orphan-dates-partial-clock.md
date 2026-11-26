---
"@ifc-lite/export": patch
---

An IFC2X3 → IFC4 or IFC4X3 export now leaves out legacy date records (`IfcCalendarDate`, `IfcLocalTime`, `IfcDateAndTime`, `IfcCoordinatedUniversalTimeOffset`) that nothing references, even when no slot converts a date. A record still referenced by an unconverted slot is kept and reported, as before. A clock whose minute or second the source left unset is still written with `00`, and the export now names each such slot in a warning.
