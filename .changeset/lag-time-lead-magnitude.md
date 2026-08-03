---
"@ifc-lite/parser": minor
---

Fix `IfcLagTime` exporting a lead time (a negative lag) with the wrong sign. When a sequence carried a negative `timeLagSeconds` and no `timeLagDuration`, the serializer's fallback reconstructed an `IfcLagTime` from the magnitude alone — so a 2-day lead (the successor may start 2 days *before* its predecessor finishes) exported as a 2-day lag, and a consumer reading the file would schedule the successor 2 days *late* instead of early: a 4-day swing, silently.

The fix: `secondsToIso8601Duration` and `parseIso8601Duration` now form a signed codec (both exported from `@ifc-lite/parser`, consolidated out of two previously-separate implementations). A negative `timeLagSeconds` encodes to the ISO 8601-2 signed form (`-P2D`) instead of either losing its sign or being dropped, and the decoder reads that sign back on import, so a lead round-trips through `ifc-lite` losslessly: `-172800` seconds → `-P2D` → `-172800` seconds.

**Interop caveat, accepted deliberately:** strict ISO 8601 durations have no sign. `-P2D` is ISO 8601-2, which `IfcDuration`'s unconstrained `STRING` type accepts, but some third-party `^P...` IfcDuration parsers reject the leading `-` outright and will drop the lag rather than read it. That is judged the better failure mode than the alternative this replaces (silently exporting the wrong sign) or dropping the lag from every export including our own re-imports — a lead is real scheduling information, and losing it in our own round trip is a worse defect than a third-party parser occasionally rejecting the field. If a consumer's `IfcDuration` parser needs unsigned durations, it will surface as that consumer failing to read the lag, not as a wrong schedule.

Reachable from the construction-schedule importer, where a CSV predecessor such as `1FS-2 days` yields a negative lag.
