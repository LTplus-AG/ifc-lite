---
"@ifc-lite/ids": patch
---

An IDS boolean written as `1` or `0` now matches the boolean it names (#ISSUE). IDS 1.0 lists `true`, `false`, `0` and `1` as valid boolean values (`Documentation/DataTypes.md`), the xs:boolean lexical space of XML Schema Part 2 (3.2.2.1), and `auditIDSDocument` already accepted all four, but the checker took only `true` and `false`, so a `simpleValue` of `1` or `0` on an IFCBOOLEAN property, or on a boolean attribute such as `IfcTask.IsMilestone`, matched nothing. For such a value:

- a required requirement now passes an element holding that boolean (it failed every element);
- an optional requirement now passes it too;
- a prohibited requirement (no `dataType`) now fails an element holding that boolean (it passed every element, a silent false pass);
- a property or attribute applicability now selects the elements holding that boolean (it selected none).

The strict-cast gate of the attribute and property facets, the boolean comparison and the audit's lexical check now read one table of the four literals, and `matchConstraint` returns `true` for a `simpleValue` of `1` against `true` and of `0` against `false` (it returned `false` before). IFC Lite also casts IFCLOGICAL as xs:boolean (IDS 1.0 maps it to xs:string), so an IFCLOGICAL property follows the same rule. Unchanged: `TRUE`, `True` and other forms outside the four still never match; `1` and `0` do not match a text value that reads `true` or `false` (an IFCLABEL, for example), only a stored boolean; numeric values are still compared as numbers; and an `xs:pattern` is still matched against `true` / `false`.
