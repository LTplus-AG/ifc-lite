---
"@ifc-lite/rules": minor
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
---

Rule sets can now assert the unit a value is recorded in, e.g. "Width is recorded in mm". The new `unit` requirement kind (`{ kind: 'unit', subject, unit: 'mm' }`) takes a property or quantity subject. An element passes when every value of that subject is recorded in the unit. The unit is the value's explicit unit, or the project unit for its measure type when it has none. IDS 1.0 cannot express this check. `readSubject` reports those units as `valueUnits`. A quantity's explicit `Unit` now also sets the unit label shown for it, where before the project unit was always shown. The parser's quantity records carry that explicit unit's symbol as `explicitUnit`. The Data validation editor offers the new kind as "Unit".
