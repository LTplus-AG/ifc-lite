---
"@ifc-lite/ids": patch
---

An entity facet whose name lists the same class more than once (an `xs:enumeration` such as IFCWALL, IFCWALL) now selects each entity once (#7537). Before, the class's ids were collected once per listed value, so every instance was a candidate twice. For such a list:

- `applicableCount`, `passedCount` and `failedCount` count each entity once. So do the report summary's totals, `summary.overallPassRate` and the totals reported through `onProgress`.
- `entityResults` holds one row per entity, so `createBCFFromIDSReport` in `@ifc-lite/bcf` writes one topic per failing entity.
- A prohibited specification fails each entity once.
- `minOccurs` and `maxOccurs` are checked against the distinct count: three walls now fail `minOccurs="4"` and pass `maxOccurs="5"`.
- Repeats no longer use up `maxEntities`. With IFCWALL, IFCWALL, IFCDOOR and a limit of 4, one wall was checked twice and the door never; now the door is checked.
- `passRate` changes where the doubling skewed it: when classes were repeated unevenly (a repeated class beside a once-listed one), when `maxEntities` cut the doubled list, or when a cardinality verdict flips.
- The exported `filterByEntityFacet` and `filterByFacet` return each id once, in first-listed order. This also holds when a repeat differs only in letter case, or when an accessor's type lists overlap. They still return every id, however many there are, as before.

A list of distinct classes returns the same ids in the same order as before, as long as each id appears once in the accessor's type lists. That holds for `createDataAccessor` on a file whose instance names are unique. On a file that declares an instance name twice, such a list now counts that entity once, while a simple value and a pattern still count it twice. A simple value, an `xs:pattern` and the IFC2X3 path that scans every entity when a listed class is an alias are unchanged.
