# 03: A prohibited facet with a value: invalid, but untested

**Upstream:** buildingSMART/IDS#206 "Interpretation of PROHIBITED for
property requirement" (open, re-evaluation planned for 1.1) and #420
(closed). **Lint:** IDSL-CARD-001.

## The ambiguity

An author who writes

```xml
<property cardinality="prohibited" dataType="IFCLABEL">
  <propertySet><simpleValue>ProposedCases</simpleValue></propertySet>
  <baseName><simpleValue>Note</simpleValue></baseName>
  <value><simpleValue>n/a</simpleValue></value>
</property>
```

means "Note must not be `n/a`". #420 lists three readings of it, and #206
records the 1.0 decision: a prohibited property with a value or dataType is
not a valid configuration, and the official audit tool reports it (#420
quotes error 202, "Invalid cardinality 'prohibited' on `property`"). #420
also reports that other open tools check the same file without complaint.
The corpus has no `invalid-` case for it, so nothing tells an implementer
that this file must be rejected.

```
#7=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Wall',$,$,$,$,$,$);
#10=IFCPROPERTYSINGLEVALUE('Note',$,IFCLABEL('ok'),$);
```

Validated anyway, the readings disagree on this wall: "no Note at all"
fails it, "no Note equal to n/a" passes it.

## What ifc-lite does, and why

`auditIDSDocument` rejects the document with `E_CARDINALITY_INVALID`
("prohibited `<property>` requirement is incompatible with @dataType"),
following the #206 decision and the official audit tool. If the document is
validated anyway, ifc-lite's validator passes the wall above, which is the
"no Note equal to n/a" reading: a prohibited facet fails only when a property
matching name, dataType and value exists. That verdict is not pinned by any
test, because the document is not valid IDS 1.0. The planned lint rule
IDSL-CARD-001 explains both readings to the author and offers the structure
that says one of them explicitly (a prohibited specification, as suggested in
#420).

## Proposed resolution

1. Add the `invalid-` case below, so the 1.0 decision is tested, not only
   recorded in an issue thread.
2. For 1.1 (#206 is scheduled for re-evaluation), if a value on a prohibited
   facet becomes valid, define it as "no property matching name **and**
   value", the reading #420 calls the most obvious intent, and add the
   pass/fail pair for the wall above.

## Proposed corpus case

- `proposed-corpus-cases/property/invalid-a_prohibited_property_cannot_constrain_a_value`

ifc-lite's audit rejects it.
