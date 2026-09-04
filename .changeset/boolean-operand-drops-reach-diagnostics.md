---
'@ifc-lite/wasm': patch
'@ifc-lite/cli': patch
---

Boolean-operand drops now reach `GeometryDiagnostics` instead of vanishing (#3821).

`BooleanClippingProcessor::take_failures` had no caller outside tests, so everything the boolean processor recorded — an unsupported operand, an `EmptyOperand` cutter, an unknown `IfcBooleanResult` operator — accumulated in a buffer nothing read, and a load whose booleans had all degraded reported zero failures. The unsupported-first-operand case recorded nothing at all: `process_operand_with_depth` returned an empty mesh for an operand type it has no branch for, and the element's item silently disappeared from the 3D view. The router now drains its processors' logs through `take_csg_failures`, so the wasm batch path, the native pipeline and `ifc-lite diagnose-geometry` all surface these, and the unsupported operand is recorded under the new `UnsupportedOperand` reason label naming the operand's IFC type. Mesh output is unchanged — this is observability, not a geometry change.

`ifc-lite diagnose-geometry` and `export --diagnostics` render `failuresByReason` verbatim, so their "Failures by reason" section gains an `UnsupportedOperand` row on affected models. `productsWithFailures` also stops counting the synthetic unattributed bucket as a product: records swept from a boolean processor's own log have no owning element, and reporting them as one product made a model with no attributed failure read as "1 product failed". Their failures still count in the totals and the reason breakdown.
