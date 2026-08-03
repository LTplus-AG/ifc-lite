---
"@ifc-lite/parser": patch
---

Fix `IfcLagTime` exporting a lead time (a negative lag) with the wrong sign. When a sequence carried a negative `timeLagSeconds` and no `timeLagDuration`, the serializer's fallback reconstructed an `IfcLagTime` from the magnitude alone — so a 2-day lead (the successor may start 2 days *before* its predecessor finishes) exported as a 2-day lag, and a consumer reading the file would schedule the successor 2 days *late* instead of early: a 4-day swing, silently.

ISO 8601 durations have no sign, and `IfcDuration` is an unconstrained `STRING` in the schema, so there is no faithful `IfcLagTime` for a lead: writing the magnitude reintroduces the swing above, and writing a signed string (`-P2D`, ISO 8601-2) is not a safer fallback either — most `^P...` IfcDuration parsers reject it outright, and a parser that strips non-digit characters instead of rejecting would read it back as the same wrong positive lag, in a file we authored.

The fix: for a lead (negative `timeLagSeconds`, no `timeLagDuration`), the sequence and its dependency link are still exported normally, but the `IfcLagTime` is dropped rather than written wrong, and `serializeScheduleToStep` now returns a `warnings` array naming the task and predecessor — the same drop-and-warn shape `mspdi.ts` already uses for percent-format lags it cannot convert. A genuine positive lag reconstructed from seconds alone is unaffected and still exports its `IfcLagTime` normally.

Reachable from the construction-schedule importer, where a CSV predecessor such as `1FS-2 days` yields a negative lag.
