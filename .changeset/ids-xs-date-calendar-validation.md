---
'@ifc-lite/ids': patch
---

`xs:date` / `xs:dateTime` / `xs:time` values are now checked against the calendar, not just the digit-run shape.

Both places that decided whether an IDS literal is a valid date did it with a regex over digit runs — `^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$` and its dateTime/time siblings. A regex of that shape cannot express a calendar, so `2024-13-45` (month 13, day 45), `2023-02-29` (not a leap year), `2024-01-01+99:99` (timezone offset out of range) and `2024-01-01T99:99:99` all passed as valid. XML Schema Part 2 §3.2.7-3.2.9 puts a value space on top of the lexical shape and excludes every one of them, so an IDS restriction or attribute value carrying a non-conformant date passed a check whose whole job is to flag it.

The calendar now lives in one place, `constraints/xsd-datetime.ts`, and both call sites go through it: the coherence audit's `xs:restriction @base` check (`E_RESTRICTION_VALUE_MISMATCH`) and the attribute/property facets' strict-cast gate (`literalCastsUnder`). Both dispatch on the shared `isXsdDateTimeBase` rather than listing bases themselves, which closes a second hole: the cast gate had arms for `xs:date` and `xs:dateTime` and none for `xs:time`, so a literal checked against a slot declaring `["xs:dateTime","xs:time"]` — `IfcTimeSeries.StartTime`, `IfcTimePeriod.EndTime`, `IfcWorkSchedule.StartTime` and their siblings — always found the permissive default through `xs:time` and passed whatever it was. An IDS attribute facet on those slots now gates its literal instead of waving it through. Month must be 1-12, the day must fall inside that month under the Gregorian leap rule, hour/minute/second must be in range with `24:00:00` accepted as XSD's end-of-day form and nothing else at hour 24, second 60 is rejected (XSD has no leap seconds), and a timezone offset must be within ±14:00 inclusive. Accepted lexical shapes are otherwise unchanged — a four-digit unsigned year, so the XSD spellings for years before 1 CE and after 9999 stay rejected exactly as they were.

Parity with upstream `IDS-Audit-tool` remains the contract for the numeric arms, where upstream's generated pattern is the only statement of what it accepts. It is not a reason to accept a value XSD excludes: this is the same call already made for the digitless doubles the upstream pattern happens to match.

`xs:duration` is untouched. Its regex has holes of its own (bare `P`), but they are a lexical question about designators rather than this calendar one, and the two copies of it disagree on fractional seconds; that needs its own decision.
