---
'@ifc-lite/export': patch
---

Fix `exportAnonymizedSubset` emitting a dangling `IFCPROPERTYREFERENCEVALUE` reference when a kept property's `PropertyReference` pointed at an `IfcPostalAddress`/`IfcTelecomAddress` the anonymization excluded (#3439).

The subset closure already refuses to walk into an excluded id, so the address itself was correctly dropped from the output — but the `IfcPropertyReferenceValue` entity naming it was still copied to the output verbatim, because the dangling-reference repair only ever rewrote `IfcRel*` lines (the same gap #3351 found for a direct `IfcSite`/`IfcBuilding` attribute slot). The result was a `#N` with no `#N=` line for that address, an invalid STEP file some readers reject outright.

`exportAnonymizedSubset` now nulls `PropertyReference` on any `IfcPropertyReferenceValue` whose target the exclusion left out, before the export closure runs — `PropertyReference` is optional, so there is no relationship-style "withhold the whole entity" fallback needed. Reported as `AnonymizeResult.stats.droppedPropertyReferenceIds`. A property whose value pointed at legitimately-included territory (e.g. an included building's own address) is unaffected.

Checked the rest of `IfcObjectReferenceSelect` (the type `PropertyReference` accepts) and the sibling property-value classes (`IfcPropertyBoundedValue`, `IfcPropertyEnumeratedValue`, `IfcPropertyListValue`, `IfcComplexProperty`): `IfcAddress` is the only member of that select ever excludable by this feature, and no sibling class's own reference-typed attribute (`EnumerationReference`, `Unit`, nested `HasProperties`) ever names an excludable type, so this closes the whole gap rather than one instance of a wider one.
