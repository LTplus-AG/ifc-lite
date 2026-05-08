---
'@ifc-lite/ids': minor
---

Add `auditIDSDocument` and `auditIDSStructure` for in-process IDS document
correctness checking — full parity with buildingSMART/IDS-Audit-tool. The
auditor passes 53/54 of the upstream `testing.shared/` regression corpus
out of the box; the remaining fixture (`xsdFailure.ids`) requires a real
XSD validator (we surface a downgraded warning instead of the structural
XSD violation).

The auditor runs four configurable phases against any IDS document:

- **Parse** — wraps `parseIDS` in a permissive shim that returns
  `IDSAuditIssue`s instead of throwing, strips UTF-8 BOM that xmldom
  rejects, and surfaces a parsed document even when later phases fail.
- **XSD** — required attributes, enum membership, structural shape, and
  `xsi:schemaLocation` URL validation against the recognised IDS schemas
  (Report 107). Each whitespace-separated `@ifcVersion` token is checked
  individually, so silently-dropped invalid tokens (e.g.
  `IFC2X3 INVALIDIFCVERSION`) get flagged.
- **IFC schema cross-check** — entity names, predefined types (incl.
  enumeration and pattern restrictions), property-set / property names,
  attribute names + value-type compatibility (Report 102 — `<value>`
  constraints on complex/entity-typed attributes are an error),
  attribute inheritance via the EXPRESS chain, partOf relations with
  per-version member/owner subtype verification, and
  classifiable/materializable applicability checks. Backed by the full
  schema tables in `@ifc-lite/data` (2711 entities, 1485 psets, 7624
  properties, 390 dataTypes, 2765 attribute rows).
- **Coherence** — empty xs:enumerations, inverted bounds, `xs:length` /
  `xs:minLength` / `xs:maxLength` restrictions, regex syntactic errors
  (real errors vs warning-only XSD-specific syntax), inverted spec-level
  cardinality, and Report 202 cardinality coherence — `optional`
  property requires `@dataType`, `prohibited` property forbids it,
  `optional` material/classification require a non-empty value, etc.

Issues use stable string-literal codes (`E_IFC_ENTITY_UNKNOWN`,
`W_IFC_PSET_RESERVED_PREFIX`, `E_RESTRICTION_RANGE`,
`E_XSD_SCHEMA_LOCATION`, `E_IFC_DATATYPE_UNKNOWN`,
`E_RESTRICTION_BASE_MISMATCH`, …) so consumers can dispatch on them
programmatically. Severity buckets (`error`, `warning`, `info`) drive
the aggregate `IDSAuditReport.status`.

Three non-breaking parser additions support the auditor:
- `IDSPartOfFacet.rawRelation` — the original `@relation` attribute when
  it didn't normalise to a recognised `PartOfRelation`.
- `IDSSpecification.ifcVersionRaw` — the original `@ifcVersion` attribute,
  so the auditor can flag tokens the parser silently dropped.
- `IDSDocument.schemaLocation` — the root `xsi:schemaLocation` value,
  used by the XSD audit to flag references to non-IDS schemas.

Two parser corrections aligning with IDS 1.0:
- `<property>` `dataType` is now correctly read from the **XML attribute**
  (`<property dataType="IFCLABEL">`) per IDS 1.0, with fallback to the
  legacy 0.9.7 child-element form. This had previously made every
  upstream fixture's `dataType` invisible to checks.
- Requirement-facet `cardinality="required|optional|prohibited"` is
  honoured per IDS 1.0, with fallback to the older `minOccurs/maxOccurs`
  encoding.

Plus a UTF-8 BOM fix in the parser — many real-world IDS files saved by
Windows tooling include a BOM that xmldom otherwise rejects.

A full 54-fixture regression suite copied from
buildingSMART/IDS-Audit-tool's `testing.shared/` corpus (MIT) is
included under `packages/ids/src/audit/__fixtures__/`.
