# Native diff compare (#8351)

This change speeds up `rust/diff` without changing any result, so a
whole-change revert can't make a behavioural test fail. Worse, it removes
`ComponentMap`, the type the adapted key-pass tests are written against, so the
tests no longer compile. The three mutations keep every type and wiring in
place and break one decision each. Each is written mutant → fixed, the way the
oracle reverse-applies it.

| patch | broken decision | witness that must fail |
|---|---|---|
| `shared-key-set.oracle.patch` | `changed_components` skips the head-only pass on "every base key found" alone, without checking that cardinalities match | `rust/diff/src/key_diff_tests.rs` (the exhaustive 81-state component walk) |
| `paired-head-rows.oracle.patch` | the key pass never records paired head rows, so every head row is reported as added | `rust/diff/src/key_diff_tests.rs` |
| `default-families.oracle.patch` | the process-wide default class-family map is built empty | `rust/diff/src/split_merge_tests.rs` (the default-family cross-class split) |

The cached `JsString` digest and `JsHash` don't get a mutation. They are covered
by `issue_8351_cached_digest_agrees_with_code_unit_equality` in
`sidecar_value.rs` and by every map lookup in the suites above. The facade's
defined-only options are covered by the `@ifc-lite/diff` vitest suite: Rust
reads an absent option exactly like an undefined one, so that change has
nothing to observe.

`warm-handle-diagnostics.json` holds the timing evidence: ordinary interleaved
diagnostics, gated on byte-identical output before timing. See the
`scripts/perf/README.md` ledger entry for the verdict.
