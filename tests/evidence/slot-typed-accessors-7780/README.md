# Typed attribute slots (#7780, F3e-0b)

`behaviour.oracle.patch` is the revert-oracle mutation for the F3e-0b PR. The PR adds `rust/core/src/slot.rs` (`Slot`, `SchemaSlot`, the typed `DecodedEntity` accessors, `EntityDecoder::slot`), the generated `generated/slots.rs` and `packages/codegen/src/rust-slot-emitter.ts`; the changed tests name all of them, so a whole-change revert is a build break (REVERT-BROKE-BUILD). The patch keeps every item and disables ONLY behaviour the tests pin:

- `schema_ordinal` swaps the IFC4X1 and IFC4X2 columns of a `SchemaSlot`;
- `logical_at` reads `.T.` as false and `.F.` as true;
- the debug owner assertion never fires;
- `EntityDecoder::slot` defaults an undeclared `FILE_SCHEMA` to IFC4 instead of IFC4X3 (D54);
- the generated `IfcProject.UnitsInContext` slot points at 9 instead of 8;
- the emitter classifies every moving slot as stable (`bySchema` always null).

Once `rust/core/src/slot.rs` is on `main` the ordinary whole-change revert resumes.
