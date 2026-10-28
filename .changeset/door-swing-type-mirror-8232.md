---
"@ifc-lite/drawing-2d": patch
---

Door plan symbols now follow the model's stated handedness. A door whose own `OperationType` is `NOTDEFINED` or absent uses its type's (`EntityMetadata.typeOperationType`, supplied by the host from `IfcDoorType`, or `IfcDoorStyle` in IFC2X3) instead of drawing as `SINGLE_SWING_LEFT`. `DoorSymbolGenerator.generateFromOpening` takes optional `doorAxes` (the placement's local X and Y projected into the drawing plane) and derives the hinge side from them per IFC4.3 `IfcDoorTypeOperationEnum`, so a mirrored placement flips the hand; without it `wallDirection` is used as before. `generateSymbol` now sweeps its arc in the sense of the given frame: a `swingDir` clockwise of `wallDir` used to start the arc off the wall line, and now closes on the opposite jamb.
