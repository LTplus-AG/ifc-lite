# @ifc-lite/regex-guard

## 0.2.0

### Minor Changes

- [#4335](https://github.com/LTplus-AG/ifc-lite/pull/4335) [`8620be3`](https://github.com/LTplus-AG/ifc-lite/commit/8620be38be0162b7cbdbe23ae7bc924763b83612) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Guard every place a caller-supplied regex pattern is compiled and run against untrusted input, closing a ReDoS (catastrophic-backtracking) hole: an IDS document's `xs:pattern` facet (four sites — the constraint matcher, the entity-type resolver, and two schema-audit sites in `@ifc-lite/ids`) and the viewer's bulk-edit "Name Pattern (Regex)" field (`@ifc-lite/mutations`'s `BulkQueryEngine.select`).
  
  New `@ifc-lite/regex-guard` package: a single shared guard (`assertGuardedRegexPattern`, `compileGuardedRegex`, `hasCatastrophicBacktrackingShape`) rejects a pattern over 256 characters or shaped like a known catastrophic-backtracking construct (`(a+)+`, `(.*)*`, …) before it is ever compiled. `@ifc-lite/extensions`'s bundle-test runner, which already had its own copy of this exact check, now imports the shared implementation instead of carrying a second one.
  
  A rejected pattern surfaces as a visible failure, not a silent non-match: an IDS specification whose pattern is rejected reports `status: 'fail'` with an `error` message (new optional field on `IDSSpecificationResult`) instead of reading as passing or not-applicable; the schema audit reports a new `E_REGEX_UNSAFE` issue; `BulkQueryEngine.select` and the entity-type resolver throw `UnsafeRegexPatternError`.
  
  This is a heuristic, not a complete defence — see the package's doc comment for what it does not catch.

### Patch Changes

- [#4379](https://github.com/LTplus-AG/ifc-lite/pull/4379) [`de30321`](https://github.com/LTplus-AG/ifc-lite/commit/de303215ad631d54069067682f443ef33d7d37f3) Thanks [@louistrue](https://github.com/louistrue)! - Add package READMEs documenting the shared regex guard and WASM lifecycle APIs, usage contracts, and limitations.
