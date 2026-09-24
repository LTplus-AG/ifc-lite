---
"@ifc-lite/rules": minor
"@ifc-lite/viewer": minor
---

Property and quantity rules can compare in SI units: `valueUnit: 'si'`, the "SI" toggle on the chip. Each value is converted with its own unit before the comparison: an explicit `Unit`, else the project unit for its measure type. This works in search, applicability and validation. `idsToRuleSet` sets it on every imported numeric check, so an imported IDS gives the same verdicts on a millimetre model as the IDS checker does. `ruleSetToIds` takes the loaded `models` and writes model-unit numeric checks to the IDS in SI. A rule whose unit can't be settled (no models, or models that disagree) is refused with the reason. The SI-units caveat note is gone. `readSubject` now also reports `valueSiScales`.
