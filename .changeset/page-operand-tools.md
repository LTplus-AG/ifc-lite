---
'@ifc-lite/cli': patch
'@ifc-lite/sdk': patch
'@ifc-lite/create': patch
'@ifc-lite/data': patch
---

Keep a PAGE directive's apostrophe operand (`'Para \S\' 5'`) inside its STEP string in the CLI's extract, subset, validate and mutate scanners, the cost-removal reference guard, group-graph reference reads and list parsing. They closed the string at the operand, which dropped real references, shifted argument slots and read `#N` text as a reference.
