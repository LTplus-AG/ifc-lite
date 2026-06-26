---
"@ifc-lite/export": patch
---

Stop dropping shared property atoms when a property is edited. Editing a property replaces its
property set and skips that set's member atoms wholesale; because exporters deduplicate shared
`Pset_*Common` atoms (e.g. one `IsExternal` `IfcPropertySingleValue` referenced by dozens of
psets), this orphaned every other pset referencing the atom, leaving dangling `#id` references —
an invalid IFC that strict readers (e.g. BIM Vision) refuse to open. `StepExporter` now retains
any atom still referenced by a surviving property set / element quantity; the edited pset still
emits its replacement with the new value while shared atoms stay for the psets that keep their
original. Fixes both single-model and merged export (the merged exporter bakes through
`StepExporter`). ([#1413](https://github.com/LTplus-AG/ifc-lite/issues/1413))
