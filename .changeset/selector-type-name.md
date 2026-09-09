---
"@ifc-lite/viewer": minor
---

`type=WT01` (IfcOpenShell selector syntax) now becomes a filter rule instead of being reported back as unsupported (#4094, follow-up to #4091/#4106): it matches the Name of the element's RELATING TYPE via `IfcRelDefinesByType` — a different dimension from a bare class term like `IfcWall`, which still matches the element's own IFC class. Supports `=`, `!=`, `*=`, `!*=` and a `/regex/` value, like `Name=`; `>`, `>=`, `<`, `<=` are not supported (a type Name is compared as text, not ordered). An element with no `IfcRelDefinesByType` relation never matches.

Still reported rather than applied: `parent=`, `query:` value queries, `+` group unions, material `Category`, and reading quantity rows from a property term. The CLI, MCP and SDK adapters do not accept selector text yet — only the viewer's Filter tab does.
