---
"@ifc-lite/ids": patch
---

An IDS boolean written as `1` or `0` now matches the boolean it names (#7543). `1` names true and `0` names false.

IDS 1.0 (`Documentation/DataTypes.md`) and XML Schema Part 2 (3.2.2.1) list `true`, `false`, `1` and `0` as boolean values. `auditIDSDocument` already accepted all four. The checker took only `true` and `false`, so a `1` or `0` matched nothing. That held for a `simpleValue` and for a value listed in an `xs:enumeration`.

What changes, for a `1` or `0` checked against a stored boolean (an IFCBOOLEAN or IFCLOGICAL property value, or a boolean attribute such as `IfcTask.IsMilestone`):

- A required or optional requirement now passes an element whose value is the boolean the literal names. It failed that element.
- A prohibited requirement now fails such an element. It passed it.
- A property or attribute applicability now selects such elements. It selected none of them.
- `matchConstraint` returns `true` for `1` against `true` and for `0` against `false`. It returned `false`.
- Matching does not read an enumeration's `base`, as it already did not for numbers. So a `1` listed under `xs:string` or `xs:integer` also matches a stored `true`. IfcTester does the same.
- `getConstraintMismatchReason` changes for an enumeration that lists `1` or `0` and holds another facet of the same restriction, such as an `xs:length`. When the list matches the stored boolean, the reason now comes from the other facet. It came from the list. A parsed IDS puts an `xs:pattern` first. For a value the pattern rejects, the reason is the pattern's, as before.
- IFC Lite reads IFCLOGICAL as xs:boolean, so an IFCLOGICAL property follows the same rule. IDS 1.0 maps IFCLOGICAL to xs:string.

How: one table of the four literals now serves three places. They are the boolean comparison, the audit, and the facets' first check that a literal can be read as the value's data type.

What does not change:

- The audit gives the same answers.
- `TRUE`, `True` and other forms outside the four never match a stored boolean.
- `1` and `0` do not match a stored text that reads `true` or `false`, such as an IFCLABEL.
- A number is still compared as a number.
- An `xs:pattern` is still matched against the text `true` or `false`.
