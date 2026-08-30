---
'@ifc-lite/parser': minor
---

Add `quantitySiScale(quantityType, units)`: the SI scale factor for an `IfcElementQuantity` (`Qto_*`) Length/Area/Volume value, resolved against a file's declared `ProjectUnits`. A `Qto_` value is stored in the project's raw author unit, exactly like a length-typed property, and this is the single place a consumer converts it to base SI before comparing or hashing it — used by the model-diff CLI adapter to fix a false "modified" on a re-authored-unit re-export (see the `@ifc-lite/cli` changeset), and mirrors the conversion `#3458` already applies on the IDS path.
