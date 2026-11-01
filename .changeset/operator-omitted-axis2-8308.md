---
"@ifc-lite/wasm": patch
---

A mapped item whose `IfcCartesianTransformationOperator3D` omits `Axis2` now follows IFC's `IfcBaseAxis`: the missing Y axis defaults to +Y projected against Axis3 and Axis1, not Axis3 × Axis1. When the two point opposite ways, which happens for example with Axis1 = −X, or with Axis3 = −Z and no Axis1, the operator is a mirror, as IfcOpenShell builds it. Before this change ifc-lite drew a 180° rotation instead, so asymmetric mapped geometry came out on the wrong side, with the right volume but the wrong position and handedness. Right-handed operators, which every exporter in the test corpora writes, give bit-identical output. The 2D operator is unchanged: IFC defines its omitted Axis2 as the orthogonal complement of Axis1.
