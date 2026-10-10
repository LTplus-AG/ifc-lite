---
"@ifc-lite/ids": minor
"@ifc-lite/rules": patch
---

IDS restriction bounds (`xs:minInclusive`, `xs:maxInclusive`, `xs:minExclusive`, `xs:maxExclusive`) are now read and compared by the restriction's `@base` instead of with `parseFloat` (#7399). A date range such as `[2024-01-01, 2024-03-31]` no longer collapses to `[2024, 2024]` and passes `2024-12-31`, and a malformed bound such as `"6,5"` under `xs:double` is no longer read as `6`.

- Numeric bases accept a bound only when its whole text is in the base's lexical space (`xs:integer` and its derivations take no fraction). Values are compared only when their whole text is numeric, so `"5 m"` or `"2024-01-01"` no longer meet a numeric bound by their prefix.
- `xs:date`, `xs:dateTime` and `xs:time` bounds compare as points on the time line, normalised to UTC, with XSD's ±14:00 rule for a value without a time zone. `xs:duration` bounds use XSD's partial order. Where XSD leaves a pair unordered, the value is not accepted. These bounds are exposed on the new `IDSBoundsConstraint.temporalBounds` field as their lexical text; the numeric `min*`/`max*` fields stay unset for them.
- A bound outside its base's lexical space fails the restriction closed, and the audit reports it as `E_RESTRICTION_FACET_UNPARSEABLE`, naming the base. Length and digit-count facets are read as whole non-negative integers too. The audit also flags inverted date, time and duration bounds.
- `@ifc-lite/rules`: `writeIdsXml` writes date, time and duration bounds back as written, and `idsToRuleSet` refuses them with a named reason.
