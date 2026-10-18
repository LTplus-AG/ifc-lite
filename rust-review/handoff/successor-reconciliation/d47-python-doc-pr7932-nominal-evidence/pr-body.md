Python `entity_data` help promised a property `kind="text"` field that the projection does not return. Align the API guide, README, stub docstring and compiled public help with `{name, value, value_type}` and display-string property values. Single-value `value_type` is the nominal value's rendered tag (for example `IFCLABEL` or `IFCREAL`); other kinds use the shared member tag or property-class keyword. Reference labels use nonblank `Name`, then nonblank `Identification`, then `#<id>`. Quantity dictionaries retain their separate numeric value and `kind` contract.

The behavioral test extracts and executes examples from the real compiled `entity_data.__doc__` using the existing C6 IFC fixture. It checks actual property keys, string values, absence of property `kind`, the separate quantity shape, and the C6 `Text` property's `IFCLABEL` tag. It requires examples and execution, so old help cannot pass vacuously. No projection logic, dictionary fields, type declarations or budget policy changes.

Follow-up to the [documentation finding in #7895](https://github.com/LTplus-AG/ifc-lite/pull/7895#discussion_r4304812454), [reference-label finding](https://github.com/LTplus-AG/ifc-lite/pull/7932#discussion_r4308878611) and [single-value tag finding](https://github.com/LTplus-AG/ifc-lite/pull/7932#pullrequestreview-5565435453); references #7783.

Validation on final head `3d2ef521dcead88104f13e6c7f532bbce8db4cfb`:

- Fresh source-matched incremental release wheel, managed PC CPU2/8GiB, Python 3.12.14 / Maturin 1.15.0. Public-help test: **1 passed, 0 skipped/errors**, executing all **11** help examples including the real `Text` → `IFCLABEL` result. Loaded native module and installed stubs match wheel archive hashes.
- Verbatim `cargo clippy --workspace --all-targets -- -D warnings` **passed on this final head**. Workspace Clippy excludes the Python crate; its build/runtime evidence comes from the wheel.
- Original backend `80b52c0d-12f5-4045-8e35-61233aa0aad5` / session83953: **COMPLETED0**, source unchanged, owned resources released.

Retained causal inverse evidence is from the earlier `e02f657d` qualification, not a new-head inverse run: separately rebuilt inverse `8302a200` restored exact public-base `779a431a` Python production files with the same test/fixture and produced exactly one `#7932: public entity_data help needs executable examples` assertion failure, 0 errors/skips. Restored `e02` passed again. This guard and the test's executable AST remain unchanged; the current test adds only a function docstring. The new nominal-tag example is positively proven on the final head. Earlier dependency/capture failures remain preserved and are not causal RED evidence.

This is the narrow Python documentation/public-help correction. No new broad Python suite, workspace test, WASM, performance or parked shared-set-budget qualification is claimed. Parent owns exact-head hosted CI and merge.
