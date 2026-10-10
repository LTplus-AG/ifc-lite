# Appendix A — IDS 1.0 cheat sheet and sharp edges

*Items marked (verify) are open assumptions in the RAID log; confirm them against the corpus before encoding them as lint errors.*

## Structure
```
ids
├── info (title, copyright?, version?, description?, author? (email), date? (xs:date), purpose?, milestone?)
└── specifications
    └── specification (name, ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2", identifier?, description?, instructions?, minOccurs/maxOccurs)
        ├── applicability (facets: ALL must match)
        └── requirements? (facets with cardinality: required | optional | prohibited)
```

## Facets
| Facet | Fields | Notes |
|---|---|---|
| entity | name, predefinedType? | Class name; predefined type per entity enum (or USERDEFINED → ObjectType). Subtypes are not matched (verify, A-03) |
| attribute | name, value? | Direct and inherited EXPRESS attributes (`Name`, `Description`, `ObjectType`, `Tag`…) |
| property | propertySet, baseName, value?, dataType? (attribute), uri? | Psets/Qtos; occurrence + type inheritance; values in SI units |
| classification | system?, value?, uri? | Reference code / system; uri links to bSDD |
| material | value?, uri? | Material name or category |
| partOf | relation?, entity | IfcRelAggregates, IfcRelAssignsToGroup, IfcRelContainedInSpatialStructure, IfcRelNests, IfcRelVoidsElement, IfcRelFillsElement |

## Values
- `simpleValue`, or `xs:restriction` with `xs:enumeration` | `xs:pattern` | min/max In/Exclusive | length, minLength, maxLength | totalDigits, fractionDigits.
- Several facets in one restriction are **conjunctive**.

## Sharp edges (each backed by a lint rule)
1. **Abstract classes** (e.g. `IfcBuildingElement`) in an entity facet match nothing directly → ENT-001.
2. **XSD regex is implicitly anchored;** `^` and `$` are literal → REGEX-001.
3. **SI units:** lengths in metres, areas in m², and so on. `2400` for a door height is almost certainly wrong → UNIT-001.
4. **String comparison is case-sensitive** and whitespace-sensitive → VAL-006, VAL-007.
5. **Optional requirement:** "if present, must comply". Without a value it checks nothing → CARD-002.
6. **Prohibited** with a value is ambiguous across tools (#206, #420) → CARD-001.
7. **Spec cardinality** `prohibited` means "no element may match the applicability", so requirements are ignored → CARD-003.
8. **IFC2X3:** many types map differently (occurrence vs type, #116). Properties may live on type objects → PROP-004.
9. **USERDEFINED predefined type** should come with an `ObjectType` requirement → PDT-002.
10. **Real-number equality** is brittle. Use ranges (tolerance is debated for 1.1, #418) → VAL-008.
11. **Reserved prefixes** (`Pset_`, `Qto_`) are for standard sets only → PSET-002.
12. **Multi-version specs** must use names valid in every listed version → VER-001.
13. **Empty strings and "present"** semantics are debated (#403). Studio flags this, it doesn't guess.
