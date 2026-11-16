---
'@ifc-lite/flood-check': patch
---

`@ifc-lite/flood-check` follow-up. Bodies given as `IfcMappedItem` (how Revit exports doors, windows and equipment) are now read through their `RepresentationMap`, placed by `MappingTarget · MappingOrigin`, with nested maps followed (depth and cycle guarded) and non-uniform scales refused as unreadable; on a Revit model this turns upper-estimate levels and uncertain positions into exact ones. A slab hole cut by a Boolean DIFFERENCE through the whole slab is read and classified like a profile hole instead of withholding every favourable outcome for the building, and a hole counts as roofed by roofs, roofing coverings, skylights and plates as well as slabs (over its whole area). A clipped body's bottom equal to the placement level is labelled a lower bound, and with no footprint the outside test answers "unknown". Fetched test fixtures fail the test run in CI when absent instead of skipping silently.
