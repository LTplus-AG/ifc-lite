# 02: Is an empty value absent, or present and wrong?

**Upstream:** buildingSMART/IDS#403 "Empty string and cardinality of
requirements" (open, no milestone).

## The ambiguity

The corpus fixes one cell of the table: a **required** property whose value
is `IFCLABEL('')` fails
(`property/fail-an_empty_string_is_considered_false_and_will_not_pass`). It
does not say why, and the two possible reasons give different answers for
the other cardinalities:

| Reading | required | optional | prohibited |
|---|---|---|---|
| "empty is **absent**" (#403 proposes this wording) | fail | pass | pass |
| "empty is **present but false/invalid**" (the test's name) | fail | fail | fail |

#403 asks for wording; no answer is recorded and no corpus case covers
optional or prohibited.

## Minimal example

```xml
<property cardinality="optional" dataType="IFCLABEL">
  <propertySet><simpleValue>ProposedCases</simpleValue></propertySet>
  <baseName><simpleValue>Label</simpleValue></baseName>
</property>
```

```
#10=IFCPROPERTYSINGLEVALUE('Label',$,IFCLABEL(''),$);
```

## What ifc-lite does, and why

ifc-lite reads an empty value (`''`, null, `UNKNOWN`) as **absent**
(`PROPERTY_EMPTY`, treated like `PROPERTY_MISSING`): required fails,
optional passes, prohibited passes. That is the reading under which the
existing corpus case and the cardinality definitions ("a property … and non
null value") stay consistent, and it is what IfcOpenShell's IfcTester does:
ifc-lite adopted it to resolve a parity report (#6117), pinned by
`packages/ids/src/__corpus__/ifctester-parity-6117/parity-6117.test.ts`.

## Proposed resolution

1. Rename the existing case to "an empty string is considered absent and will
   not pass" (the wording suggested in #403).
2. Add one sentence to the property and attribute facet docs: "An empty
   string, a null value and the logical UNKNOWN count as absent, for every
   cardinality."
3. Add the two cases below so the reading is tested, not inferred.

## Proposed corpus cases

- `proposed-corpus-cases/property/pass-an_empty_string_is_absent_for_an_optional_property`
- `proposed-corpus-cases/property/pass-an_empty_string_is_absent_for_a_prohibited_property`

ifc-lite gives both `pass`.
