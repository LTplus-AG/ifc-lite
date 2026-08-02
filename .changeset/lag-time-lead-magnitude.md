---
"@ifc-lite/parser": patch
---

Fix `IfcLagTime` losing a lead time's magnitude on export. The schedule serializer's `timeLagSeconds` fallback — used whenever a sequence carries no `timeLagDuration` — clamped any non-positive value to `PT0S`, so a lead (a negative lag, e.g. a successor starting two days before its predecessor finishes) exported as a zero-length lag rather than a two-day one.

ISO 8601 durations have no sign, and `IfcDuration` is an unconstrained `STRING` in the schema, so an exported `IfcLagTime.LagValue` cannot express direction either way. Losing the sign is therefore unavoidable; losing the *magnitude* was not. The fallback now emits the absolute value, so a two-day lead exports as `P2D` instead of `PT0S`.

Reachable from the construction-schedule importer, where a CSV predecessor such as `1FS-2 days` yields a negative lag.
