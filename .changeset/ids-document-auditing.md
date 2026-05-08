---
'@ifc-lite/ids': minor
---

Add `auditIDSDocument` and `auditIDSStructure` for in-process IDS document
correctness checking — full parity with buildingSMART's `IfcTester-Service`
audit endpoint, no network round-trip required. Authoring tools can now drop
the HTTP call and consume structured `IDSAuditReport` objects directly.

The auditor runs four configurable check phases against any IDS document:

- **Parse** — wraps `parseIDS` in a permissive shim that returns
  `IDSAuditIssue`s instead of throwing, so partial documents still produce
  a structured report.
- **XSD** — required attributes, enum membership (incl. each token in
  whitespace-separated `@ifcVersion` strings), structural shape and the
  empty-applicability / empty-requirements cases.
- **IFC schema cross-check** — entity names, predefined types (including
  enumeration and pattern restrictions), property-set / property names,
  attribute names against the inheritance chain, and partOf relations
  with subtype-of-owner verification. Backed by the new full schema
  tables in `@ifc-lite/data` (771/932/1008 entities and 317/408/760
  property sets across IFC2X3 / IFC4 / IFC4X3).
- **Coherence** — empty xs:enumerations, inverted bounds, regex patterns
  that don't compile under JS, and inverted spec-level cardinality.

Issues use stable string-literal codes (`E_IFC_ENTITY_UNKNOWN`,
`W_IFC_PSET_RESERVED_PREFIX`, `E_RESTRICTION_RANGE`, …) so consumers can
dispatch on them without parsing messages. Severity buckets (`error`,
`warning`, `info`) drive the aggregate `IDSAuditReport.status`.

Two non-breaking parser additions support the auditor:
- `IDSPartOfFacet.rawRelation` — the original `@relation` attribute
  string when it didn't normalise to a recognised `PartOfRelation`.
- `IDSSpecification.ifcVersionRaw` — the original `@ifcVersion` attribute
  string, so the auditor can flag tokens the parser silently dropped.

A 17-fixture regression suite copied from buildingSMART/IDS-Audit-tool's
`testing.shared/` corpus (MIT) is included under
`packages/ids/src/audit/__fixtures__/`, exercising every phase against
real-world IDS documents.
