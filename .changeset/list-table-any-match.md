---
"@ifc-lite/rules": minor
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
---

**Behaviour change:** property rules now read list, enumerated and table values member by member, in search, applicability and validation. A positive operator passes when ANY member matches, which is how IDS checks these values. A negated operator (`ne`, `notContains`, `notMatches`) passes only when NO member has the value.

This changes results for existing rules on these properties. Before, a rule compared the joined display string. `Colors = Blue` against the list `(Red, Blue)` used to fail and now passes. `Colors = "Red, Blue"` used to pass and now fails. `Colors != Red` against `(Red, Blue)` used to pass and now fails. Negated operators in search also stop passing on a single non-matching property set when a regex set name matches several sets. This is the same NONE rule validation already applied.

`@ifc-lite/parser` marks each extracted property with a `structure` (`enumerated`, `bounded`, `list`, `table`, `reference`, `complex`) when it is not a single value. The filter value suggestions offer list members. `propertyCandidates` is exported.
