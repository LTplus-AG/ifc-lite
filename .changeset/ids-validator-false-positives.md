---
"@ifc-lite/ids": patch
---

Fix three IDS-validator false positives that flagged valid IDS documents and (in
one case) blocked model validation entirely.

**Type-entity property applicability (#1441).** A standard occurrence pset is
equally applicable to its companion type entity — IFC lets the same pset attach
to either the occurrence or its type. The audit's applicability cross-check only
matched occurrence subtypes, so an IDS that targets type entities (e.g.
`IfcActuatorType`) with an element pset (e.g. `Pset_ManufacturerTypeInformation`,
declared applicable only to `IfcElement`) was wrongly reported as
`E_IFC_PROP_NOT_IN_PSET`. Because that is an `error`, it disabled the Run
Validation button. The check now expands a pset's applicable occurrence classes
with their companion type entities (via the authoritative `typeEntity` link, with
a schema-validated `<Occurrence>Type` naming fallback for IFC2X3, whose rows omit
the link).

**Quantity sets in IFC4/IFC2X3 (#1442).** The upstream schema data only
enumerates `Qto_*` quantity sets for IFC4X3, so IFC2X3/IFC4 carry no quantity-set
rows at all and a standard set such as `Qto_SpaceBaseQuantities` tripped the
reserved-prefix warning (`W_IFC_PSET_RESERVED_PREFIX`). The reserved-prefix check
now only fires for a `Qto_*` name when the schema version actually has
quantity-set coverage to check against — without that data we cannot tell an
authoring typo from a real standard set, so suppressing the warning is the honest
choice. `Pset_*` coverage is complete, so bogus `Pset_*` names still warn in every
version, and bogus `Qto_*` names still warn in IFC4X3.

**Empty requirements on a prohibited spec (#1444).** A prohibited specification
(`<applicability maxOccurs="0">`) asserts that no entity matches and the IDS spec
requires its requirements to be empty, yet the audit warned "specification has no
<requirements>". The warning is now suppressed when the applicability declares an
explicit numeric `maxOccurs` (prohibited `0` or a bounded count), where the
cardinality itself is the assertion. Default-cardinality specs with no
requirements still warn.
