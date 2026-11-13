# R2 activity and result builders (#9668)

Measured base: `f3bd911e632c22edeb271c409a2419ada2aaf636`. Rows remain 56/119. Cells rise from 273.5/774 to 297.5/774; create rises from 34.5/110 to 58.5/110. No cell drops. R1 remains retained.

The two boundary-node create cells in IFC4 and IFC4X3 already pass on the measured base (r1 recorded fail). This PR adds 24 passing create cells. Every other level is unchanged.

## Every changed cell since r1

| Row | Level | Before | After | Reason |
|---|---|---|---|---|
| IFC2X3/IfcStructuralLoadPlanarForce | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralLoadSingleDisplacement | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralLoadSingleForce | create | pass | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralLoadTemperature | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralPlanarAction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralPointReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC2X3/IfcStructuralResultGroup | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcBoundaryNodeCondition | create | fail | pass | Already on measured base: point-support SELECT export fix. |
| IFC4/IfcStructuralCurveReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralLoadLinearForce | create | pass | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralLoadPlanarForce | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralLoadSingleDisplacement | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralLoadSingleForce | create | pass | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralLoadTemperature | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralPlanarAction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralPointReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralResultGroup | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralSurfaceAction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4/IfcStructuralSurfaceReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcBoundaryNodeCondition | create | fail | pass | Already on measured base: point-support SELECT export fix. |
| IFC4X3/IfcStructuralCurveReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralLoadLinearForce | create | pass | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralLoadPlanarForce | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralLoadSingleDisplacement | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralLoadSingleForce | create | pass | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralLoadTemperature | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralPlanarAction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralPointReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralResultGroup | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralSurfaceAction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |
| IFC4X3/IfcStructuralSurfaceReaction | create | fail | pass | New activity/result builder and scene; exported values and schema validated without weakening probes. |

## Deliberately left

Varying actions, generic CurveAction and LoadConfiguration need a distribution/configuration contract. SingleForceWarping and SingleDisplacementDistortion need warping/distortion support, which no builder here writes. LinearForce and SingleForce already have builders and are reused by reactions. Items, boundary resources, connection conditions, eccentricities and reinforcement are outside this activity/result slice; #9737 owns surface members and curve/surface connections. Update, removal, conversion and read gaps remain unchanged.
