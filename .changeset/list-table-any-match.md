---
"@ifc-lite/rules": minor
"@ifc-lite/parser": minor
"@ifc-lite/data": minor
"@ifc-lite/mutations": patch
"@ifc-lite/viewer": minor
---

**Behaviour change:** element rules now read list, enumerated and table property values member by member, in search, applicability and validation. A positive operator passes when ANY member matches. A negated operator (`ne`, `notContains`, `notMatches`) passes only when NO member has the value.

Before, these rules compared the joined display string, so results change for existing list-valued properties. Against the list `Colors = (Red, Blue)`:
- `Colors = Blue` used to fail and now passes.
- `Colors = "Red, Blue"` used to pass and now fails.
- `Colors != Red` used to pass and now fails.

In search, negated operators also stop passing on a single non-matching property set when a regex set name matches several sets. That is the NONE rule validation already applied.

The set checks (`unique`, `aggregate`, `compare`) still read each property as one whole value, the joined text, so their results do not change.

Bounded values and complex properties keep their display value. Lens colouring, the CLI's `--where` and bulk-edit queries are not rules and keep their own matching. Models whose properties come from a server-parsed property table carry no structure marker, so they keep the joined value.

`@ifc-lite/parser` marks each extracted property with a `structure` (`enumerated`, `bounded`, `list`, `table`, `reference`, `complex`) when it is not a single value, and exports the `ExtractedProperty` type. `@ifc-lite/data`'s `Property` declares the same field, and `MutablePropertyView` keeps it on base properties. The filter value suggestions offer list members. `propertyCandidates` and `readSubjectWhole` are exported.
