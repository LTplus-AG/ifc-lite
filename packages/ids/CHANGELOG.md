# @ifc-lite/ids

## 1.15.2

### Patch Changes

- Updated dependencies [[`bfb5e1b`](https://github.com/louistrue/ifc-lite/commit/bfb5e1bdc917ab771de4540b6c5686b9fb0e5fa7)]:
  - @ifc-lite/parser@2.4.1

## 1.15.1

### Patch Changes

- Updated dependencies [[`2ab0e4c`](https://github.com/louistrue/ifc-lite/commit/2ab0e4c0eafc21feb22bfc7cd96c467b8b9ff599)]:
  - @ifc-lite/parser@2.4.0
  - @ifc-lite/data@1.17.0

## 1.15.0

### Minor Changes

- [#623](https://github.com/louistrue/ifc-lite/pull/623) [`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43) Thanks [@louistrue](https://github.com/louistrue)! - Add `auditIDSDocument` and `auditIDSStructure` for in-process IDS document
  correctness checking — full parity with buildingSMART/IDS-Audit-tool.
  **The auditor passes all 54 fixtures of the upstream `testing.shared/`
  regression corpus** (100% parity).

  The auditor runs five configurable phases against any IDS document:

  - **Parse** — wraps `parseIDS` in a permissive shim that returns
    `IDSAuditIssue`s instead of throwing, strips UTF-8 BOM that xmldom
    rejects, and surfaces a parsed document even when later phases fail.
  - **XSD shape** — walks the raw XML DOM against the IDS 1.0 XSD's
    element shapes (mirrors upstream's `IdsXmlNode.cs` approach: per-
    element allowed-attribute and allowed-child tables encoded from
    `Resources/XsdSchemas/ids.xsd`). Catches unknown attributes and
    child elements anywhere in the document — the only way to flag the
    upstream `xsdFailure.ids` fixture without pulling in a generic XSD
    validator.
  - **XSD field** — required attributes, enum membership, and
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
    `xs:minLength` / `xs:maxLength` restrictions, full XSD regex semantics
    (`\i`, `\c`, `\d`, `\w` and negations translated to JS Unicode
    property escapes — see `audit/coherence/regex.ts`, ported from
    upstream `XmlRegex.cs`; char-class subtraction warns), inverted
    spec-level cardinality, and Report 202 cardinality coherence —
    `optional` property requires `@dataType`, `prohibited` property
    forbids it, `optional` material/classification require non-empty
    value, etc.

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

### Patch Changes

- Updated dependencies [[`7c85376`](https://github.com/louistrue/ifc-lite/commit/7c853760ef96e6f0f88ebdc29c17aefae724ff43)]:
  - @ifc-lite/data@1.16.0

## 1.14.11

### Patch Changes

- [#615](https://github.com/louistrue/ifc-lite/pull/615) [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d) Thanks [@louistrue](https://github.com/louistrue)! - Add `@xmldom/xmldom` as a runtime fallback for environments where the
  global `DOMParser` is undefined (Node.js, Web Workers without DOM,
  embedded contexts). Browser builds keep using the native `DOMParser` —
  the xmldom fallback is loaded dynamically only when needed, so the
  browser bundle is unaffected. Also surface fatal xmldom v0.9 ParseError
  exceptions as a clear `Failed to parse IDS XML` error instead of letting
  them bubble unannotated.

## 1.14.10

### Patch Changes

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162)]:
  - @ifc-lite/data@1.15.2

## 1.14.9

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/data@1.15.1

## 1.14.8

### Patch Changes

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7), [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/data@1.15.0

## 1.14.7

### Patch Changes

- Updated dependencies [[`113bafc`](https://github.com/louistrue/ifc-lite/commit/113bafc07436c809a8cb24d8682cf63ae5ed99e9)]:
  - @ifc-lite/data@1.14.6

## 1.14.6

### Patch Changes

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/data@1.14.5

## 1.14.5

### Patch Changes

- Updated dependencies [[`d2ebb34`](https://github.com/louistrue/ifc-lite/commit/d2ebb3457e261934df41c8f7f647531de6198078)]:
  - @ifc-lite/data@1.14.4

## 1.14.4

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix IDS applicability parsing and cardinality validation for prohibited specifications

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/data@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/data@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [[`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/data@1.7.0

## 1.6.0

### Minor Changes

- Initial tracked version
