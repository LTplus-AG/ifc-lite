# @ifc-lite/ids

## 1.15.52

### Patch Changes

- [#3339](https://github.com/LTplus-AG/ifc-lite/pull/3339) [`b3921ac`](https://github.com/LTplus-AG/ifc-lite/commit/b3921ac56bb3b8d4522f980009fecb0994ae8acf) Thanks [@louistrue](https://github.com/louistrue)! - `xs:double` now accepts the special literals upstream IDS-Audit-tool accepts.
  
  `literalCastsUnder(value, 'xs:double')` rejected `NaN`, `+INF` and `-INF`, which
  upstream accepts.
  
  The coherence audit was NOT the counterexample this change was first written
  against. Its table carries upstream's pattern, but `isValidLexicalForXsType`
  vetoes any value with no digit before that pattern runs, and none of the three
  specials has a digit. So both sites reject the three specials and agree with each other there, while
  both diverge from upstream.
  
  They do NOT agree everywhere, and the first draft of this changeset said they
  did. Measured: upstream also accepts an exponent-only family (`e5`, `+e5`,
  `.e5`), and the audit's digit veto is SATISFIED by the digit in the exponent, so
  the audit accepts those while the cast rejects them. That split predates this
  change. The audit follow-up has to reconcile both classes, not just the
  specials.
  
  This fixes the cast.
  
  Upstream is the contract here, and it is neither .NET nor XSD. It generates the
  validator as a regex, `^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$`,
  which takes `+INF` (an XSD 1.1 spelling) while rejecting bare `INF` (the 1.0
  one), and rejects `Infinity` (the .NET one). The coherence table already carried
  that pattern verbatim, behind a veto that suppresses it for these inputs.
  
  A family of deviations is kept and documented at the call site: every part of upstream's
  pattern is optional, so it also matches `""`, `"+"`, `"."`, `"-"`, `"+."` and
  the exponent-only forms. Those fall out of how the regex is written rather than
  being a decision, and accepting an empty string as a double turns a malformed
  IDS literal into a passing constraint. The cast keeps rejecting them. The test
  pins representatives rather than the whole family, and says so.
  
  The docblock claiming these arms mirror `int.TryParse` / `double.TryParse` was
  wrong and is corrected: upstream does not use `TryParse` for this.
- Updated dependencies [[`111b733`](https://github.com/LTplus-AG/ifc-lite/commit/111b733b21915522cf9678fb05d4595ac4a8906e), [`758ed93`](https://github.com/LTplus-AG/ifc-lite/commit/758ed93f24d48dd0067568a1e4b62f9380e9d131)]:
  - @ifc-lite/data@3.5.1

## 1.15.51

### Patch Changes

- [#3269](https://github.com/LTplus-AG/ifc-lite/pull/3269) [`b342063`](https://github.com/LTplus-AG/ifc-lite/commit/b34206376700e5544a908a94d18cf89af9501772) Thanks [@BIMvoice](https://github.com/BIMvoice)! - An IDS property facet on an `IfcDescriptiveMeasure` property can pass again.
  `ifcMeasureToXsdTypes` decides which XSD types an IDS literal must cast under
  before the value comparison runs, and it reached that answer through a
  `*MEASURE` / `*RATIO` suffix heuristic. `IfcDescriptiveMeasure` ends in
  `MEASURE` but is `TYPE IfcDescriptiveMeasure = STRING;` in both IFC4 and
  IFC4X3 — the descriptive-text member of `IfcMeasureValue` — so its literal was
  run through a numeric cast that any descriptive text fails, and the facet
  reported a mismatch even when the stored value equalled the requested one
  character for character.
  
  Three more measures disagreed with their EXPRESS base in the other direction:
  `IfcIntegerCountRateMeasure` is `INTEGER`, not `REAL`, so the gate accepted
  `3.0`; `IfcParameterValue` (`REAL`) and `IfcPositiveInteger` (`INTEGER`) end in
  neither suffix and so got no cast gate at all. All four are now named
  explicitly, and a test re-derives the expectation for every measure the
  `IfcValue` SELECT can reach directly from the EXPRESS schemas, so the table
  cannot drift from them again.

- [#3277](https://github.com/LTplus-AG/ifc-lite/pull/3277) [`78354d9`](https://github.com/LTplus-AG/ifc-lite/commit/78354d9607cee098d34df037299c344b0d1e6103) Thanks [@BIMvoice](https://github.com/BIMvoice)! - An `<xs:restriction>` that declares more than one facet now enforces all of
  them. `parseRestriction` returned the first family it recognised — pattern,
  then enumeration, then bounds/length — and discarded the rest, but XSD facets
  in one restriction are conjunctive. Because the discarded facets are the
  narrowing ones, this reported models as compliant that were not: a value of
  `999` satisfied `minInclusive 10` + `maxInclusive 20` + `pattern \d+`, and
  `"ABCDEFGHIJ"` satisfied `maxLength 3` + `pattern [A-Z]+`, in both cases because
  only the pattern survived parsing.
  
  The parser now builds every family present. The first stays the constraint
  itself, so the `pattern` / `enumeration` / `bounds` switches in the auditor, the
  translation layer and the facet checkers see the shape they already handle; the
  rest ride along in a new optional `and` list that `matchConstraint` requires as
  well. A restriction declaring a single family is unchanged, `and` unset.
  
  Both report paths follow: `formatConstraint`'s expected-value display and
  `describeConstraint`'s human-readable text now name every facet, joined by a new
  `constraints.conjunction` string in each locale, and the mismatch reason points
  at the facet that actually rejected the value. Describing only the primary would
  state a weaker requirement than the one being enforced.
  
  Still unchanged: `xs:totalDigits`, `xs:fractionDigits` and `xs:whiteSpace` are
  not read at all, and the IDS-document auditors under `audit/` inspect only the
  primary family, so a malformed regex or an inverted bound in a sibling facet is
  not linted.

- [#3251](https://github.com/LTplus-AG/ifc-lite/pull/3251) [`846a2ba`](https://github.com/LTplus-AG/ifc-lite/commit/846a2baf2c0df700ab14480509b2ef2446d6d3cd) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix an IDS property check on an `IfcTimeStamp` property never being able to pass.
  
  The strict XSD-cast gate mapped `IfcTimeStamp` to `xs:duration`, alongside
  `IfcDuration`. `IfcTimeStamp` is declared `INTEGER` in every bundled schema — a
  UNIX epoch second — so the literal an author has to write (`1609459200`) failed
  the ISO-8601 duration pattern and the facet returned `PROPERTY_VALUE_MISMATCH`
  whatever the model contained; an actual duration literal (`P1Y2M3D`) passed
  where it should not.
  
  It now answers per schema version, matching what the generated attribute table
  gives the attribute facet for `IfcOwnerHistory.CreationDate`: `xs:integer`
  under IFC2X3, and `xs:integer` / `xs:dateTime` under IFC4 and IFC4X3. A single
  union across versions would have replaced the original false-REJECT with a
  false-ACCEPT on IFC2X3, where an ISO-8601 date-time literal would pass the
  property facet and be rejected by the attribute facet on the same file — the
  disagreement the mapping exists to prevent. Callers with no schema version in
  hand still get the permissive union.

- [#3266](https://github.com/LTplus-AG/ifc-lite/pull/3266) [`302121a`](https://github.com/LTplus-AG/ifc-lite/commit/302121ac7bc9312b1073738b3bbe0956ce452cf4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Recognise `IfcQuantityNumber` instead of relabelling it as a count
  
  IFC4X3 added `IfcQuantityNumber` to the `IfcPhysicalSimpleQuantity` family,
  but `QuantityType` stopped at `Time`, so the parser's lookup fell through to
  its `?? QuantityType.Count` default. The value survived; the type did not. A
  `Number` quantity was exported to Parquet as `Count`, described to IDS as
  `IFCCOUNTMEASURE`, and written back out by the STEP exporter as
  `IFCQUANTITYCOUNT` — a silent entity rewrite on round-trip.
  
  `QuantityType.Number` now exists and the parser, the Parquet and STEP
  exporters, the IDS data-type bridge and the viewer's unit table all carry it.
  A schema-derived test in `@ifc-lite/data` asserts the enum against the
  generated per-version entity tables in both directions, so the next subtype a
  schema regeneration introduces reds rather than falling through.
- Updated dependencies [[`b456e27`](https://github.com/LTplus-AG/ifc-lite/commit/b456e279831dbde5b2889b788aada9bd06ff32b8), [`8092522`](https://github.com/LTplus-AG/ifc-lite/commit/80925228ec72aca31d7e9fa3ab4466895c4b1f66), [`98828c4`](https://github.com/LTplus-AG/ifc-lite/commit/98828c4b004506b6d31546ce93b533fa26e808ea), [`98828c4`](https://github.com/LTplus-AG/ifc-lite/commit/98828c4b004506b6d31546ce93b533fa26e808ea), [`36350e8`](https://github.com/LTplus-AG/ifc-lite/commit/36350e8439af3c52d62d8bb3f6e2daa7bb8d4fa2), [`329008d`](https://github.com/LTplus-AG/ifc-lite/commit/329008d2324204ff39d2ac4a0423add6a60e8907), [`c1490aa`](https://github.com/LTplus-AG/ifc-lite/commit/c1490aa48037c396d014f1dcb9647934fc16e43d), [`38460bd`](https://github.com/LTplus-AG/ifc-lite/commit/38460bd543d6c869db15f867b129db6f965695da), [`e2c67f0`](https://github.com/LTplus-AG/ifc-lite/commit/e2c67f084bfca20ff82460ae54aa80a383fcb39a), [`302121a`](https://github.com/LTplus-AG/ifc-lite/commit/302121ac7bc9312b1073738b3bbe0956ce452cf4), [`08cbf72`](https://github.com/LTplus-AG/ifc-lite/commit/08cbf72dbb3e375d20f703c8c813d4cd873657c1), [`c8049a0`](https://github.com/LTplus-AG/ifc-lite/commit/c8049a0bf464cd1fec7a4cd2aad2f08326e04737), [`c2885ef`](https://github.com/LTplus-AG/ifc-lite/commit/c2885ef575fe57d9bc8e1960bb0ea31cb02f0665), [`bb3fc2c`](https://github.com/LTplus-AG/ifc-lite/commit/bb3fc2c5af754a120b98b545e186303de0fb4951)]:
  - @ifc-lite/parser@4.3.2
  - @ifc-lite/data@3.5.0

## 1.15.50

### Patch Changes

- Updated dependencies [[`224386a`](https://github.com/LTplus-AG/ifc-lite/commit/224386ac9cb1c2d94eca50808cdfdb7e8a3121e5)]:
  - @ifc-lite/parser@4.3.1

## 1.15.49

### Patch Changes

- [#3121](https://github.com/LTplus-AG/ifc-lite/pull/3121) [`ffcc9e6`](https://github.com/LTplus-AG/ifc-lite/commit/ffcc9e6f048cd263a5b70946417c9b6aceec1bec) Thanks [@BIMvoice](https://github.com/BIMvoice)! - IDS numeric comparison no longer takes seconds per entity on a crafted property
  value.
  
  `packages/ids/src/constraints/comparators.ts` decided "is this a strict numeric
  literal?" with `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`. On a string that
  **fails** the match, `\d+\.?\d*` retries at every split of the digit run before
  the engine gives up, so the cost is quadratic in the length. Measured here on
  `'-' + '9'.repeat(n) + 'X'`: 26 ms at n=5,000, 413 ms at n=20,000, 3,701 ms at
  n=60,000 — 4x the input for 16x the time.
  
  That input is reachable. `compareNumeric` runs the check on the model side, and
  `matchSimpleValue` / `matchEnumeration` call it once per entity, so an IFC
  property whose value is a long digit run followed by any non-numeric character
  costs that much per entity for the whole model. A validation run against an
  uploaded file could be stalled by the file. Note that a long digit run *without*
  the trailing character matches immediately, which is why this never showed up in
  ordinary use.
  
  Both call sites now use `isWhollyNumeric` from `@ifc-lite/encoding` — the
  hand-written linear scan that already decides this exact language for the CSV
  formula guard. Same three inputs: 0.008 ms, 0.031 ms, 0.090 ms. The scan is also
  cheaper on ordinary values, which matters because this is a per-entity path
  (1e6 calls on `'2022-01-01'`: 42 ms with the regex, 13 ms with the scan), and it
  allocates nothing.
  
  The accepted language is unchanged. `.5`, `5.`, `+.5`, `-5.`, `5.e3` and `1e+5`
  are still numeric literals; `1e`, a lone `+`/`-`/`.`, the empty string,
  whitespace-padded digits, `Infinity`, `NaN`, `0x10`, `1_000` and `2022-01-01`
  are still not. That is pinned by running the removed regex as the oracle over
  every string up to four characters from the alphabet the language is built from
  (69,905 of them), not by a hand-written table. `@ifc-lite/encoding` is a new
  dependency of `@ifc-lite/ids`; it has no dependencies of its own.
  
  Two more copies of the same shape inside this package are bounded the same way,
  on IDS-file literals rather than model values — lower reach, since they run once
  per literal rather than once per entity, but the same cost curve on an uploaded
  IDS file:
  
  - `constraints/xsd-cast.ts` used a byte-identical regex for the `xs:double`
    strict cast; it now calls `isWhollyNumeric` too. 439 ms → under 1 ms at
    n=20,000.
  - `audit/coherence`'s lexical-space table spelled the `xs:double` / `xs:float` /
    `xs:decimal` mantissa `[0-9]*\.?[0-9]*`, two adjacent digit runs with the same
    problem. It is now `[0-9]*(?:\.[0-9]*)?` — the same accepted language,
    including `NaN` / `+INF` / `-INF`, one parse per prefix. 415 ms → under 1 ms at
    the same length.
  
  The IDS numeric tolerance rules and every other comparator are untouched, and
  the buildingSMART IDS corpus stays at 334/334 parity.

- [#3094](https://github.com/LTplus-AG/ifc-lite/pull/3094) [`a8587cc`](https://github.com/LTplus-AG/ifc-lite/commit/a8587cc21c309ebd6c87119cb0d1cd6d1005c281) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Compare a `partOf` parent's `predefinedType` case-sensitively, as the entity facet already does
  
  The IDS XSD gives the `partOf` facet's nested `<entity>` the same complex type an entity facet uses, but the two checkers each wrote out their own copy of the `<predefinedType>` matching rule and the copies had drifted: `entity-facet.ts` compared case-sensitively (enum tokens are uppercase by the IFC schema, and the buildingSMART corpus case `entity/fail-user_defined_types_are_checked_case_sensitively` requires an `IfcWall` carrying `ObjectType = 'waldo'` to fail a facet asking for `WALDO`), while `partof-facet.ts` passed a case-insensitive option on every branch. One and the same (raw enum token, user-defined name, IDS literal) triple therefore got opposite verdicts depending on which facet asked, and a `partOf` requirement whose literal differed from the model only in casing wrongly PASSED.
  
  The rule now lives once, in `facets/predefined-type-match.ts`, and both facets consume its verdict; each still owns only its own failure wording. The diagnostics-free applicability twin `entityFacetPasses`, which held a third copy, calls it too.
  
  No public API change.
- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/encoding@2.1.0
  - @ifc-lite/data@3.4.1

## 1.15.48

### Patch Changes

- [#2789](https://github.com/LTplus-AG/ifc-lite/pull/2789) [`b4740a1`](https://github.com/LTplus-AG/ifc-lite/commit/b4740a1fb18050c065e8fbd58714626bdf852f00) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add regression tests pinning `PSET_MISSING` and `PARTOF_RELATION_MISSING`
  in `checkRequirement`'s `optional` allowlist (`packages/ids/src/validation/validator.ts`).
  
  Per the IDS spec, `optional` means "if present, must satisfy" -- a
  wholly-absent facet passes, a present-but-wrong facet fails. The allowlist
  that implements this already covered eight failure-type codes, but two of
  them -- `PSET_MISSING` (entity has no property sets at all) and
  `PARTOF_RELATION_MISSING` (entity has no parent under the requested
  relation at all) -- had no test forcing that exact shape, so either could
  be silently dropped from the allowlist without failing `vitest run` or the
  vendored buildingSMART corpus runner. Dropping either causes a
  wrong-direction regression: entities that legitimately have nothing would
  start failing an `optional` requirement instead of passing it.
  
  No production logic changed. This also re-verifies the other six codes in
  the same allowlist (`ATTRIBUTE_MISSING`, `PROPERTY_MISSING`,
  `CLASSIFICATION_MISSING`, `MATERIAL_MISSING`, `PREDEFINED_TYPE_MISSING`,
  `PARTOF_PREDEFINED_TYPE_MISSING`) individually against both suites; all
  six were already pinned by at least one of `vitest run` or
  `npm run test:ids-corpus`.

- [#2897](https://github.com/LTplus-AG/ifc-lite/pull/2897) [`969cff9`](https://github.com/LTplus-AG/ifc-lite/commit/969cff95a77ce4c17a949a93632c8a0378fd3ede) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix an IDS entity facet naming an IFC4-only class (`IfcAirTerminal`, `IfcFilter`, `IfcValve`, …) never matching anything in an IFC2X3 model.
  
  IFC2X3 predates those classes; the same concept there is a generic occurrence class (`IfcFlowTerminal`, `IfcFlowTreatmentDevice`, `IfcFlowController`, …) related to a specific type object (`IfcAirTerminalType`, `IfcFilterType`, `IfcValveType`, …) via `IfcRelDefinesByType`. buildingSMART's IDS spec defines an occurrence/type mapping table so a facet naming the IFC4-only class still matches the equivalent IFC2X3 pair ("the definition of an IDS applicability facet with entity `IfcFilter`, should result in the identification of all `IfcFlowTreatmentDevice` that are associated with a type `IfcFilterType`") — this package implemented no such mapping, so every entity facet using one of the table's 55 aliases against an IFC2X3 model reported zero applicable entities regardless of content. `packages/ids/src/facets/ifc2x3-type-mapping.ts` now carries the table (scoped to IFC2X3 only — IFC4+ already has a dedicated class for every alias), consulted by `checkEntityFacet`, `entityFacetPasses` and the applicability broadphase filter.
  
  Also fix a property facet applied directly to `IfcMaterial` always reporting the property set missing. `IfcMaterialProperties` (IFC4+) / `IfcExtendedMaterialProperties` (IFC2X3) attach property sets straight to the material, not through `IfcRelDefinesByProperties` like every other pset, and `collectAllPropertySets` never read them.
  
  Found via buildingSMART's official IDS conformance corpus (16 test cases added upstream since this repository's [#1685](https://github.com/LTplus-AG/ifc-lite/issues/1685) vendoring, re-synced here): all 6 `pass-` cases covering these two gaps previously failed.
- Updated dependencies [[`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2)]:
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/data@3.4.0

## 1.15.47

### Patch Changes

- Updated dependencies [[`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599)]:
  - @ifc-lite/parser@4.1.0

## 1.15.46

### Patch Changes

- Updated dependencies [[`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d)]:
  - @ifc-lite/parser@4.0.3

## 1.15.45

### Patch Changes

- Updated dependencies [[`02079a6`](https://github.com/LTplus-AG/ifc-lite/commit/02079a66042a6e446b9f83f656685f6056020718)]:
  - @ifc-lite/data@3.3.0

## 1.15.44

### Patch Changes

- Updated dependencies [[`7ee619f`](https://github.com/LTplus-AG/ifc-lite/commit/7ee619f8c6a7490982136d5677674f4f6355a568), [`1de1696`](https://github.com/LTplus-AG/ifc-lite/commit/1de16969db1c56f4901e4af49da74085bae3b3fe)]:
  - @ifc-lite/parser@4.0.2
  - @ifc-lite/data@3.2.4

## 1.15.43

### Patch Changes

- Updated dependencies [[`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/data@3.2.3
  - @ifc-lite/parser@4.0.1

## 1.15.42

### Patch Changes

- [#2282](https://github.com/LTplus-AG/ifc-lite/pull/2282) [`79781f5`](https://github.com/LTplus-AG/ifc-lite/commit/79781f57c50bbc9641516a42d0de53e5b9d89932) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `optional` requirements incorrectly failing when a nested `predefinedType` constraint is checked against an entity (or, for `partOf`, a related entity) that has no predefined type at all.

  Per IDS semantics, `optional` means "if present, must satisfy" — a wholly absent attribute passes, same as `ATTRIBUTE_MISSING`/`PROPERTY_MISSING`/etc. already do. `PREDEFINED_TYPE_MISSING` and `PARTOF_PREDEFINED_TYPE_MISSING` were left out of that "wholly absent" allow-list, so an `optional` entity or `partOf` requirement with a `predefinedType` sub-constraint reported `fail` instead of `pass` whenever the target had no predefined type data — the opposite of what `optional` promises.

- [#2316](https://github.com/LTplus-AG/ifc-lite/pull/2316) [`403f448`](https://github.com/LTplus-AG/ifc-lite/commit/403f4485c21b9928f16566fa482c170f230852b0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a false FAIL on `partOf` requirements whose nested `entity.predefinedType` constraint asks for the literal `USERDEFINED` token against a parent that also carries a custom name.

  `getAncestors` sourced `ParentInfo.predefinedType` from `getObjectType`, which collapses a `USERDEFINED` raw enum to the accompanying user-defined name (e.g. `ObjectType`/`ElementType`). A spec requiring predefinedType `USERDEFINED` on the parent then compared that literal against the custom name instead of the raw token, and failed — even though `entity-facet.ts`'s direct entity check accepts exactly this case via its raw-token-first, user-name-fallback match.

  `ParentInfo` now carries the raw `PredefinedType` token separately from the user-defined name (`objectType`), and `partof-facet.ts`'s predefinedType match mirrors `entity-facet.ts`'s two-branch logic: raw token first, falling back to the user-defined name only when the raw token is `USERDEFINED`.

- Updated dependencies [[`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da)]:
  - @ifc-lite/data@3.2.2
  - @ifc-lite/parser@4.0.0

## 1.15.41

### Patch Changes

- Updated dependencies [[`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9)]:
  - @ifc-lite/data@3.2.1
  - @ifc-lite/parser@3.15.1

## 1.15.40

### Patch Changes

- Updated dependencies [[`d008604`](https://github.com/LTplus-AG/ifc-lite/commit/d0086043fa88f488d19942ffe9241d80bab4be6a)]:
  - @ifc-lite/parser@3.15.0

## 1.15.39

### Patch Changes

- Updated dependencies [[`c65bdbe`](https://github.com/LTplus-AG/ifc-lite/commit/c65bdbe033494e71e35e0222895fa1d017f0fd76)]:
  - @ifc-lite/parser@3.14.0

## 1.15.38

### Patch Changes

- Updated dependencies [[`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841)]:
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0

## 1.15.37

### Patch Changes

- [#1968](https://github.com/LTplus-AG/ifc-lite/pull/1968) [`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88) Thanks [@louistrue](https://github.com/louistrue)! - Fix type-inherited properties disappearing when the occurrence carries a property set of the same name ([#1913](https://github.com/LTplus-AG/ifc-lite/issues/1913)).

  IFC inherits type properties **per property**, not per property set. An occurrence and its `IfcTypeProduct` routinely both carry a set of the same name holding different properties — `Pset_CoveringCommon` with `IsExternal`/`Reference` on an `IfcCovering` and `SurfaceSpreadOfFlame`/`Combustible`/`ThermalTransmittance` on its `IfcCoveringType` is a plain Revit export. Both the IDS bridge and the viewer's Lens adapter treated a name collision as "occurrence replaces type" and dropped the entire inherited set, making every type-only property in it invisible.

  For IDS that meant a property that is present, and that other tools resolve, was reported missing: `Property "SurfaceSpreadOfFlame" not found in "Pset_CoveringCommon". Available: Pset_CoveringCommon.IsExternal, Pset_CoveringCommon.Reference`. For Lens it silently removed those properties from grouping and filtering.

  `@ifc-lite/parser` gains `mergeInheritedPropertySets(ownSets, inheritedSets)`, which unions the two per property with the occurrence winning on a property-name collision (the more specific definition), matching `IfcRelDefinesByType` semantics. Both consumers now use it, so the rule has one home rather than two divergent copies. Neither input is mutated — cached extractor results stay intact.

  Only the collision case changes. A type set whose name the occurrence does not use was already appended and still is; a property defined on both sides still resolves to the occurrence's value; a property on neither side is still absent.

- Updated dependencies [[`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88)]:
  - @ifc-lite/parser@3.12.0

## 1.15.36

### Patch Changes

- Updated dependencies [[`9a7b5a2`](https://github.com/LTplus-AG/ifc-lite/commit/9a7b5a2fc1bb85ce60e954ccf7819829e43431d6)]:
  - @ifc-lite/data@3.1.0

## 1.15.35

### Patch Changes

- Updated dependencies [[`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336)]:
  - @ifc-lite/data@3.0.0
  - @ifc-lite/parser@3.11.0

## 1.15.34

### Patch Changes

- Updated dependencies [[`3441fb9`](https://github.com/LTplus-AG/ifc-lite/commit/3441fb9e902daea8ed7d6f1a692e75618bbecb7e)]:
  - @ifc-lite/data@2.8.0
  - @ifc-lite/parser@3.10.1

## 1.15.33

### Patch Changes

- [#1795](https://github.com/LTplus-AG/ifc-lite/pull/1795) [`613a1bf`](https://github.com/LTplus-AG/ifc-lite/commit/613a1bf6e8f6b3678ce6bd214e746e82dd11f73d) Thanks [@louistrue](https://github.com/louistrue)! - IDS validation on server-parsed models now sees type-inherited property sets ([#1787](https://github.com/LTplus-AG/ifc-lite/issues/1787)). The bridge's `appendInheritedPropertySets` resolved type psets only via `extractTypePropertiesOnDemand`, which bails on the empty `source` buffer of a server-parsed store — so a facet checking a property that lives on the element's `IfcTypeProduct` (rather than the instance) passed on the in-browser path but was invisible on the server path. It now falls back to the prebuilt property table keyed by the type id (resolved through `IfcRelDefinesByType`), mirroring the Lists server-path type fallback. No wire or cache change; the WASM path is unaffected (guarded on empty `source`).

- [#1762](https://github.com/LTplus-AG/ifc-lite/pull/1762) [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940) Thanks [@louistrue](https://github.com/louistrue)! - Material association hardening (follow-up to [#1755](https://github.com/LTplus-AG/ifc-lite/issues/1755)):

  - **Multiple `IfcRelAssociatesMaterial` per element** are no longer lost. New `resolveAllMaterialDefIds` / `extractAllMaterialsOnDemand` surface every association (relationship-graph backed, ordered by rel express id). The single-entry `onDemandMaterialMap` "primary" is now deterministic — the association with the LOWEST rel express id wins — and the viewer cache rebuild applies the same rule, so a cache load can no longer disagree with a fresh parse. Models where the old last-wins rule picked a later association may report a different primary material in single-value surfaces (MCP/CLI/SDK).
  - `buildMaterialUsageIndex` lists elements under EVERY associated material, so the By Material tab and per-material totals include secondary associations.
  - `extractMaterialPropertiesOnDemand` aggregates `Pset_Material*` across all associations instead of only the primary.
  - **IDS**: material facets now check every association — a requirement satisfied only by an element's second association no longer false-fails.
  - **Constituent-set fractions**: constituents without an authored `Fraction` receive an equal share of the unallocated remainder instead of weight 0, so they contribute to per-material quantity totals.

- [#1785](https://github.com/LTplus-AG/ifc-lite/pull/1785) [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90) Thanks [@louistrue](https://github.com/louistrue)! - IDS validation on server-parsed models now matches candidate values for multi-valued properties (enumerated / bounded / list / table), for INSTANCE-attached properties, identically to the in-browser path ([#1766](https://github.com/LTplus-AG/ifc-lite/issues/1766)). The server emits the same `values[]` candidate array `parsePropertyValue` produces — enumerated/list members, bounded lower/upper/setPoint (deduped), table defining-then-defined values — as a JSON-encoded nullable `values_json` column (data-model cache v4 → v5, sparse: only multi-value rows). The decoder parses it, `convertServerDataModel`'s `materializeProp` attaches it to the property entry, and the existing IDS bridge (`projectProperty` → facet `candidateValues`) consumes it unchanged, so a facet passes when the constraint matches ANY candidate (not just the joined display value). `@ifc-lite/data`'s `Property` gains an optional `values?: string[]`.

- Updated dependencies [[`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90), [`6102a22`](https://github.com/LTplus-AG/ifc-lite/commit/6102a222a6a71afcdab89855f1dcfa9437d3994f)]:
  - @ifc-lite/data@2.7.0
  - @ifc-lite/parser@3.10.0

## 1.15.32

### Patch Changes

- Updated dependencies [[`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7)]:
  - @ifc-lite/parser@3.9.1
  - @ifc-lite/data@2.6.0

## 1.15.31

### Patch Changes

- Updated dependencies [[`ae6079f`](https://github.com/LTplus-AG/ifc-lite/commit/ae6079f0d2d8a3dbc923dfd468817c7f3e2f9b4a)]:
  - @ifc-lite/parser@3.9.0

## 1.15.30

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/parser@3.8.5

## 1.15.29

### Patch Changes

- Updated dependencies [[`422d47d`](https://github.com/LTplus-AG/ifc-lite/commit/422d47dde37c7168ce4a547fc0a4f966649c1762)]:
  - @ifc-lite/data@2.5.3
  - @ifc-lite/parser@3.8.4

## 1.15.28

### Patch Changes

- Updated dependencies [[`ec53138`](https://github.com/LTplus-AG/ifc-lite/commit/ec53138f252578253b55e1caf28a23dc9cc61de9)]:
  - @ifc-lite/parser@3.8.3

## 1.15.27

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/parser@3.8.2

## 1.15.26

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/parser@3.8.1

## 1.15.25

### Patch Changes

- Updated dependencies [[`d758460`](https://github.com/LTplus-AG/ifc-lite/commit/d758460dce1a564286a9af5579b0a2ba72dfa81d)]:
  - @ifc-lite/data@2.5.0
  - @ifc-lite/parser@3.8.0

## 1.15.24

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0

## 1.15.23

### Patch Changes

- Updated dependencies [[`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1)]:
  - @ifc-lite/parser@3.6.0

## 1.15.22

### Patch Changes

- Updated dependencies [[`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229)]:
  - @ifc-lite/data@2.3.0
  - @ifc-lite/parser@3.5.2

## 1.15.21

### Patch Changes

- bc1d2b0: Fix three IDS-validator false positives that flagged valid IDS documents and (in
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

## 1.15.20

### Patch Changes

- Updated dependencies [[`d567c4e`](https://github.com/LTplus-AG/ifc-lite/commit/d567c4eb55edf7f2e68f67709c3716cda0bf5360)]:
  - @ifc-lite/parser@3.5.1

## 1.15.19

### Patch Changes

- Updated dependencies [[`8a4ce69`](https://github.com/LTplus-AG/ifc-lite/commit/8a4ce694ea1d8c1b0f25310f8a1addb3ff649f14)]:
  - @ifc-lite/parser@3.5.0

## 1.15.18

### Patch Changes

- Updated dependencies [[`f746659`](https://github.com/LTplus-AG/ifc-lite/commit/f746659ada2c918d88ea8458240e5d91b3f348f4)]:
  - @ifc-lite/parser@3.4.1

## 1.15.17

### Patch Changes

- Updated dependencies [[`297ae7b`](https://github.com/LTplus-AG/ifc-lite/commit/297ae7bc232519fe06a25d6ea20f39290e8a7ed2)]:
  - @ifc-lite/parser@3.4.0

## 1.15.16

### Patch Changes

- Updated dependencies [[`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf)]:
  - @ifc-lite/parser@3.3.2

## 1.15.15

### Patch Changes

- Updated dependencies [[`b6acbc4`](https://github.com/LTplus-AG/ifc-lite/commit/b6acbc4b84bcdb4a2d774515200d27edd7e831cb)]:
  - @ifc-lite/data@2.2.0

## 1.15.14

### Patch Changes

- [#1210](https://github.com/LTplus-AG/ifc-lite/pull/1210) [`249761a`](https://github.com/LTplus-AG/ifc-lite/commit/249761ab7f1d51ce46b3058b595a6fad7c26db7e) Thanks [@louistrue](https://github.com/louistrue)! - Accept the IDS `partOf` facet's merged voids/fills relation. The IDS XSD
  enumerates `IFCRELVOIDSELEMENT IFCRELFILLSELEMENT` as a single
  space-separated token (the two relations were merged upstream), but it was
  flagged as an invalid relation on import and silently collapsed to
  voids-only. It is now recognised end-to-end: the parser preserves the
  combined relation, the schema auditor accepts it, and the ancestor walk
  follows both the fills and voids edges so an element reaches its host
  building element through the opening. Fixes [#1205](https://github.com/LTplus-AG/ifc-lite/issues/1205).
- Updated dependencies [[`249761a`](https://github.com/LTplus-AG/ifc-lite/commit/249761ab7f1d51ce46b3058b595a6fad7c26db7e)]:
  - @ifc-lite/data@2.1.1

## 1.15.13

### Patch Changes

- Updated dependencies [[`d5aa38d`](https://github.com/LTplus-AG/ifc-lite/commit/d5aa38db57e90ecd69512cfad426a902a0eccebf)]:
  - @ifc-lite/parser@3.3.1

## 1.15.12

### Patch Changes

- Updated dependencies [[`bfd9004`](https://github.com/LTplus-AG/ifc-lite/commit/bfd9004daa17f481a7b33b5c3c11f620e6cd894d), [`248f2c0`](https://github.com/LTplus-AG/ifc-lite/commit/248f2c09a4d61fa27dfeaba5511a2a641d4cd278), [`ddae2b0`](https://github.com/LTplus-AG/ifc-lite/commit/ddae2b0024f071d00f9e6e4b77e0be3965412ec3)]:
  - @ifc-lite/data@2.1.0
  - @ifc-lite/parser@3.3.0

## 1.15.11

### Patch Changes

- [#1102](https://github.com/LTplus-AG/ifc-lite/pull/1102) [`25ecce8`](https://github.com/LTplus-AG/ifc-lite/commit/25ecce854d0eaa378228224bb8b786eb5a81dc21) Thanks [@louistrue](https://github.com/louistrue)! - Fix IDS `xs:pattern` value-restriction matching ([#1100](https://github.com/LTplus-AG/ifc-lite/issues/1100), [#1101](https://github.com/LTplus-AG/ifc-lite/issues/1101)).

  - Pattern facets now match the lexical form of the value gated by the
    restriction's `@base`, so `<restriction base="xs:decimal"><pattern value="^.*$"/>`
    ("any decimal value present") passes on numeric properties instead of
    failing every one. A number under an `xs:string` base (or a boolean
    under a numeric base) is still a type mismatch, matching the
    buildingSMART corpus.
  - XSD `\p{...}` / `\P{...}`, `\d`, `\w`, `\i`, `\c` are now translated to
    their Unicode equivalents (compiled with the `u` flag) via a single
    shared translator, so e.g. `\p{L}+` no longer wrongly matches digits.
    The translator is character-class aware (`[\w]` → `[\p{L}\p{Nd}]`) and
    approximates constructs JS can't model (Unicode block escapes,
    char-class subtraction) permissively rather than rejecting valid values.

## 1.15.10

### Patch Changes

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/data@2.0.3

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
