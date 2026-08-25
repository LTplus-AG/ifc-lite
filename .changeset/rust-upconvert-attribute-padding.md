---
"@ifc-lite/wasm": patch
---

Pad the attributes a newer schema appended when the Rust STEP converter upgrades a file.

`convertStepLine` in `packages/export` has padded the trailing optional attributes newer schemas ADD since #1416 — `PredefinedType` on `IfcWall` / `IfcBeam` / `IfcOpeningElement`, `IfcMaterial`'s `Description` and `Category`, and 61 more. Its Rust port never got the fix, and the Rust port is what `exportStep` runs, so `ifc-lite export --format step --schema IFC4` on an IFC2X3 source wrote entities one or more positional attributes short. That is an invalid IFC4 file, and strict readers reject it. Verbatim, before:

```
#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsTu',$,'W1',$,$,$,$,'tag');
```

and after:

```
#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsTu',$,'W1',$,$,$,$,'tag',$);
```

Padding applies only where the source schema's positional attribute NAME list is a strict PREFIX of the target's — the same restriction the TypeScript half enforces at run time. Entities that reorder or insert mid-list (`IfcMaterialProperties` goes from `[Material]` to `[Name, Description, Properties, Material]`) are left untouched, because a trailing `$` there would shove existing values into the wrong and type-invalid slots.

The two implementations are now pinned to one shared fixture, `rust/export/tests/fixtures/schema_upconvert_sweep.json`, whose rows are derived from the generated buildingSMART attribute tables and which NAMES every padded type rather than counting them — a count floor stays silent exactly when a row is dropped.
