---
"@ifc-lite/export": patch
---

Stop re-declaring an out-of-range property as `IfcPHMeasure` or `IfcHeatingValueMeasure`.

Regenerating a property set writes each property back with the declared type its source line carried, unless the value falls outside that type's EXPRESS WHERE rule. The table of constrained `IfcValue` members listed six of the eight, so `IFCPHMEASURE(99.)` (`WR21 : {0.0 <= SELF <= 14.0}`) and `IFCHEATINGVALUEMEASURE(-5.)` (`WR1 : SELF > 0.`) were emitted as schema-invalid lines. Both now relax to `IFCREAL(...)`, and the drift test derives the constrained set from the bundled EXPRESS schemas instead of guessing it from the member's name.
