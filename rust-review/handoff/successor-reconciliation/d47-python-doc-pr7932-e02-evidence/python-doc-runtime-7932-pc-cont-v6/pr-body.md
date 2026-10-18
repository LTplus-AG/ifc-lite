Python `entity_data` help promised a property `kind="text"` field that the projection does not return. Align the API guide, README, stub docstring and compiled public help with `{name, value, value_type}` and display-string property values. Describe reference labels accurately: nonblank `Name`, then nonblank `Identification`, then `#<id>`. Quantity dictionaries retain their separate numeric value and `kind` contract.

Add executable public-help examples and a behavioral test that extracts and executes them from the real compiled `entity_data.__doc__` using the existing C6 IFC fixture. It checks actual property keys, string values, absence of property `kind`, and the separate quantity shape. The test requires examples and execution, so old help cannot pass vacuously. No projection logic, dictionary fields, type declarations or budget policy changes.

Follow-up to the [documentation finding in #7895](https://github.com/LTplus-AG/ifc-lite/pull/7895#discussion_r4304812454) and the [reference-label review](https://github.com/LTplus-AG/ifc-lite/pull/7932#discussion_r4308878611); references #7783.

Validation on exact head `e02f657dd877bc6aaa5864bada3994d940edf1fd`:

- Fresh source-matched release wheel on managed PC, Python 3.12.14 / Maturin 1.15.0. Candidate public-help test: 1 passed, 0 skipped; help contains 9 executable examples. Loaded native module and installed stubs match wheel archive hashes.
- Declared inverse `8302a200` restores the Python production files to exact public-base `779a431a` bytes while retaining identical test/fixture bytes. Its separately rebuilt wheel yields exactly 1 assertion failure: `#7932: public entity_data help needs executable examples`; 0 collection errors or skips. Candidate source/wheel restored and the same test passed again.
- `cargo clippy --workspace --all-targets -- -D warnings` passed verbatim on final head. Workspace Clippy excludes the Python crate; the fresh wheel provides the Python build/runtime evidence.
- Final managed continuation `7c01311c-ece3-4f6f-bfae-61da2d36ddc0`: COMPLETED0, source unchanged, resources released. The candidate wheel was built in preceding job `9636d339`; that job stopped before tests at an NTFS pytest capture error. Continuation used supported `--capture=sys` and verified the retained wheel identity. Earlier dependency/capture failures remain preserved; neither is claimed as causal RED.

This is the narrow Python documentation/public-help correction. It does not qualify the parked shared-set budget implementation, broader Python suites, WASM, or performance.
