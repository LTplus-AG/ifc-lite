<!-- SPDX-License-Identifier: MPL-2.0 -->
Admitted diagnostic 5959063e runs the original f8ca Rust browser artifact with
verbose ChromeDriver logging. The WASM hash is unchanged before/after. The
filtered real test never starts: Chrome rejects retained-driver.mjs and
plane-certificate.mjs served as application/octet-stream. The raw DevTools
error entries and original terminal receipt are retained here; omitted traffic
is not represented as an exhaustive browser trace. This identifies HTTP module
loading failure, not a geometry result. Correct module MIME at the local test HTTP boundary for private snippets and
staged SDK modules; actual numerical/browser rerun remains required.
