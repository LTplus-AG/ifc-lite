---
"@ifc-lite/create": minor
---

LandXML → IFC (mapping v1.3, spec §14): station equations are now written instead of refused. Each `StaEquation` on a written alignment becomes an `IfcReferent` / `.STATION.` with `Pset_Stationing` (`Station`, `IncomingStation`, `HasIncreasingStation`), linearly placed at its distance along the alignment's curve and nested with the start referent in order along the alignment. An alignment's equations are refused all or none, by name, when one cannot be placed. A vertical profile on an alignment with station equations is no longer refused: its PVI stations are read as displayed stations and placed through the stationing, and only a station in an equation's gap or displayed at more than one place is refused. `AlignmentParams` gains an optional `StationEquations` list and `AlignmentResult` an `equationReferentIds` list; `StationEquationParams` is exported. `CgPoint`s stay `IfcAnnotation` / `.SURVEY.` (§14.3 records why).
