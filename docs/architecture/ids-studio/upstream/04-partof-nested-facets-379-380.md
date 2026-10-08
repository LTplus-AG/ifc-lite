# 04: Facets nested in partOf lose "exactly one entity"

**Upstream:** buildingSMART/IDS#379 "Conditional PartOf specifications"
(open, milestone 1.1) and the draft pull request #380 "add more facets to
PartOf" (open, unreviewed).

## The ambiguity

#379 wants "every space on the storey named 01 is named 01-…". IDS 1.0
partOf can find the storey but cannot say anything about it. #380 lets
attribute, property, classification and material facets sit inside partOf
and apply to the related element, by changing `partOfType` from

```xml
<xs:sequence>
  <xs:element name="entity" type="ids:entityType" minOccurs="1"/>
</xs:sequence>
```

to an unbounded `xs:choice` of `entity` and the other facets. Inside an
unbounded choice, `minOccurs="1"` on `entity` no longer guarantees an
entity, and nothing limits it to one. #379 says "at least one entity". So
under #380 a partOf with no entity, or with two, is schema-valid.

```xml
<partOf relation="IFCRELAGGREGATES">
  <entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>
  <entity><name><simpleValue>IFCBUILDING</simpleValue></name></entity>
  <attribute><name><simpleValue>Name</simpleValue></name><value><simpleValue>01</simpleValue></value></attribute>
</partOf>
```

Two entity facets on one related element are conjunctive and, for two
distinct classes, can never match.

## What ifc-lite does, and why

The IDS 1.1 preview (`preview: { ids11: true }`) implements #380 with the
most conservative reading: exactly one related entity (the audit reports
anything else), nested facets judged on the related element exactly as
applicability facets would judge it. It is pinned on the IFC4 model
`AC20-FZK-Haus.ifc`, whose two storeys aggregate six and one spaces: the
nested Name facet selects 6 or 1 of the 7 spaces
(`packages/ids/src/preview/ids11-model.test.ts`).

## Proposed resolution

Keep `entity` mandatory and single, and put the choice after it:

```xml
<xs:sequence>
  <xs:element name="entity" type="ids:entityType"/>
  <xs:choice minOccurs="0" maxOccurs="unbounded">
    <xs:element name="attribute" type="ids:attributeType"/>
    <xs:element name="property" type="ids:propertyType"/>
    <xs:element name="classification" type="ids:classificationType"/>
    <xs:element name="material" type="ids:materialType"/>
  </xs:choice>
</xs:sequence>
```

This is backwards compatible with every IDS 1.0 file and states in the
schema what #379 asks for in prose. Also state in `partof-facet.md` that the
nested facets apply to the related element, and that a transitive relation
matches when any ancestor matches the entity and all nested facets.

## Proposed corpus cases (IDS 1.1)

- `proposed-corpus-cases/ids11-partof/pass-a_nested_facet_selects_the_related_element`
- `proposed-corpus-cases/ids11-partof/fail-a_nested_facet_must_match_the_related_element`

Written by the ifc-lite IDS 1.1 preview writer; ifc-lite gives both the
named verdict with the preview on.
