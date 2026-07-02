---
"@ifc-lite/export": minor
"@ifc-lite/cli": minor
---

feat(export): add `unitReconciliation: 'normalize'` merge mode

`MergedExporter` can now rescale a model whose length unit differs from the first
model's into the primary unit, so a mixed-unit merge produces one ordinary
single-unit `IfcProject` with one `IfcUnitAssignment` (opens correctly everywhere,
BIM Vision included) instead of a multi-project federation.

- Every length-valued datum is rescaled: all `IfcCartesianPoint` /
  `IfcCartesianPointList` coordinates, scalar lengths (extrusion depths, profile
  dimensions, radii, thicknesses, `IfcVector.Magnitude`, CSG primitive sizes,
  `IfcBuildingStorey.Elevation`, `IfcSite.RefElevation`), `IfcLengthMeasure`
  property values, and `IfcQuantityLength`. Which attributes are length-valued is
  derived from the IFC schema registry, not hand-rolled.
- Areas and volumes are converted by their own declared `AREAUNIT`/`VOLUMEUNIT`
  ratio (not the length factor squared/cubed), so a model with millimetre lengths
  but square-/cubic-metre quantities (the common authoring-tool default) is not
  corrupted.
- Angles, direction ratios, counts, unit definitions and georeferencing offsets
  are left untouched. `MergeExportResult.stats.normalizedModelCount` reports how
  many models were rescaled, and advisories are surfaced for schemas the length
  registry does not fully cover (IFC4X3) and for georeferenced models.

The CLI `merge` command gains a `--unit-reconciliation <auto|normalize|assume-shared>`
flag, and the viewer's merged export adds a "Mixed units" selector.
