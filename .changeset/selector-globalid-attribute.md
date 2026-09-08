---
"@ifc-lite/viewer": minor
---

Two more IfcOpenShell selector constructs now become filter rules instead of being reported back as unsupported (#4094, follow-up to #4091/#4106):

- A bare GlobalId term (`325Q7Fhnf67OZC$$r43uzK`) or its `!`-subtracted form now becomes a `globalId` filter rule, evaluated as an exact, case-sensitive comparison — several terms in one selector union or subtract, the same way class terms do.
- An IFC attribute other than `Name` or `PredefinedType` (`Description=`, `ObjectType=`, `Tag=`, `LongName=`, or any other schema-named attribute) now becomes a generic `attribute` filter rule, read from the same on-demand per-entity extraction the IDS attribute facet uses. All eight comparison operators work, and `= NULL` / `!= NULL` read as presence checks, same as a property term. `GlobalId=` written as a comparison (rather than the bare-GlobalId term) stays reported: the underlying extraction never surfaces `GlobalId` as a named attribute, so routing it through the generic rule would silently match nothing.

Still reported rather than applied: `type=`, `parent=`, `query:` value queries, `+` group unions, material `Category`, and reading quantity rows from a property term. The CLI, MCP and SDK adapters do not accept selector text yet — only the viewer's Filter tab does.
