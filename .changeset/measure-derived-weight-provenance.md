---
"@ifc-lite/viewer": minor
---

Measure: derive a mass from geometry volume × material density, labelled as derived.

The Quantities panel reported a weight only when the file declared an `IfcQuantityWeight`. A model with geometry and materials but no declared weight reported nothing, even though everything needed to compute one was present.

It now derives a mass from the meshed geometry volume (the same value the "Volume mesh" row reports, after opening cuts) times the material density the file declares in `Pset_MaterialCommon.MassDensity`, and shows it as its own **"Mass derived"** row.

**It is a separate row, never the same number.** A declared `Qto` weight, a mass computed from a density the file declared, and a mass estimated from a density the file did not are three different confidence levels. They are totalled separately and labelled separately, the same way the panel already refuses to read a bare `Volume` as a `NetVolume`. The row's tooltip and a footnote both say the figure is calculated and not an IFC-declared quantity.

**A declared weight is never derived over.** When the file states a weight, that is the answer and no derivation runs for that element — including when a volume and a density are both available.

**An untrusted volume produces no mass at all.** For a model federation alignment re-baked (`'same-crs'` / `'reprojected'`), the proved volume describes a size that is no longer on screen (#1993), so no mass is derived from it and the existing note explains why. Likewise, an element whose materials declare *different* densities gets no mass: without each material's share of the volume there is no answer, and the panel says so rather than picking one.

Units route through `project_units` as the single source: densities convert from the file's `MASSDENSITYUNIT` and the result renders in `MASSUNIT`, honouring the per-unit-type display override. The row says "Mass" rather than "Weight" because kg/m³ × m³ is a mass; where a file's `MASSUNIT` resolves to a force symbol instead, no mass is derived and the panel reports that rather than guessing between kilograms and kilonewtons.

Scope: only the file's own density is wired. There is no project density library in the viewer today, so the "estimated from a library density" basis is modelled and tested but has no configured source yet. IFC2X3's `IfcGeneralMaterialProperties.MassDensity` — a scalar attribute rather than a property set — is still not read by the parser, so IFC2X3 files carrying their density that way are unaffected.

Closes #2736.
