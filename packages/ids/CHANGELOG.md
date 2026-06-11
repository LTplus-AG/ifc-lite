# @ifc-lite/ids

## 1.15.9

### Patch Changes

- [#1063](https://github.com/LTplus-AG/ifc-lite/pull/1063) [`5b62de7`](https://github.com/LTplus-AG/ifc-lite/commit/5b62de78ef135ef47893d15c3e11b52b47d29d57) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): accept IFCLABEL for enumerated standard pset properties in the IDS audit.

  The audit flagged `W_IFC_DATATYPE_MISMATCH` for any dataType declared on a
  standard enumerated property (e.g. `Pset_ProjectCommon.ProjectType`,
  `Pset_Address.Purpose`) because enumeration kinds carry no dataType in the
  generated pset definitions. PEnum values serialize as IfcLabel, so IFCLABEL
  is the canonical IDS dataType — upstream IdsLib's `HasDataTypes` maps
  `EnumerationPropertyType` to `["IFCLABEL"]`, and authoring tools (ACCA
  usBIM.IDS, IDSedit) emit IFCLABEL for these properties. A genuinely wrong
  dataType on an enumerated property still errors, and the message now names
  the expected type instead of "typed enumeration".

  Property shapes with no known backing type (e.g. table values) are now
  skipped instead of mismatching against every declaration, matching upstream
  behavior when `HasDataTypes` returns false.

## 1.15.8

### Patch Changes

- [#1055](https://github.com/LTplus-AG/ifc-lite/pull/1055) [`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1) Thanks [@louistrue](https://github.com/louistrue)! - fix(ids): make IDS validation usable on large models with code-list IDS packs.

  Validating a 550k-entity model against an 848-spec IDS document took ~19
  minutes of CPU, produced multi-GB reports, and the CLI then hung forever
  after printing its results. Four root fixes:

  - parser: `yieldToEventLoop` leaked one open `MessageChannel` per yield;
    in Node an open `MessagePort` holds a libuv handle, so every CLI command
    on a large file kept the process alive after completion. Ports now close
    (helper consolidated into one shared module).
  - ids: `validateIDS` wraps the accessor in a per-run memoizing cache so
    property sets / types / attributes are extracted once per entity instead
    of once per entity _per specification_ (O(specs×entities) source
    re-parses → O(entities)). Enumeration constraints additionally compile
    into exact-match sets (real-world code lists carry 800+ values).
  - ids: per-entity result strings are now bounded — enumeration constraints
    render at most 10 values in failure messages, and the entity-independent
    requirement description is formatted once per requirement instead of per
    entity result (reports for failing models dropped from GBs to MBs).
  - cli: `ifc-lite ids` now uses the canonical `@ifc-lite/ids/bridge`
    accessor (the drifted local copy missed type-inherited property sets),
    reports real progress (`spec 312/848 (37%)` instead of
    `undefined (undefined/undefined)`), and skips retaining passing entity
    results for human-readable output (`--json` is unchanged).

  Behavior change (intentional): the CLI's PASS/FAIL verdict and exit code
  now come from the validator's per-spec status, which counts
  cardinality-only failures — a `minOccurs="1"` specification that matches
  zero entities now correctly FAILs (exit 1) where it previously passed
  silently. `bim.ids.summarize` likewise prefers the per-spec status when
  the report carries one, so `--json` and text mode agree on the verdict.

  Measured on the same model + IDS pack: 848 specs 19min→2min, 117 specs
  3.4min→12s, both with a clean exit instead of a hang.

- Updated dependencies [[`594b90c`](https://github.com/LTplus-AG/ifc-lite/commit/594b90c99cf5e2bc40735232e0b02691be7b2ed1)]:
  - @ifc-lite/parser@3.1.3

## 1.15.7

### Patch Changes

- Updated dependencies [[`f4ad10f`](https://github.com/LTplus-AG/ifc-lite/commit/f4ad10f2fef12e720b0966060a928d0a4e2b32b1)]:
  - @ifc-lite/parser@3.1.2

## 1.15.6

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/parser@3.1.1

## 1.15.5

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/data@2.0.1

## 1.15.4

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/data@2.0.0

## 1.15.3

### Patch Changes

- Updated dependencies [[`bdb9978`](https://github.com/LTplus-AG/ifc-lite/commit/bdb997842fe38627fefbcddf250fc0136289bc84)]:
  - @ifc-lite/parser@2.4.2

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
