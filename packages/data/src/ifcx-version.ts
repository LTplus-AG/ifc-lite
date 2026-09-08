/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The value every IFCX writer in this repo puts in `header.ifcxVersion`.
 *
 * Readers match case-insensitively on the substring `ifcx` (see `parseIfcx`),
 * which is forgiving enough that divergence between writers stays invisible.
 * It did: seven call sites hardcoded this string, six of them `ifcx_alpha` and
 * `packages/ifcx`'s own writer `IFCX-1.0`, and nobody noticed because both
 * parse. What the forgiving read DIDN'T cover was the key itself — the Rust
 * exporter wrote `header.version` for its whole life and every file it produced
 * was rejected by our own parser, fixed in #2556 by an outside contributor.
 *
 * One constant, one value, so the next writer inherits it instead of guessing.
 *
 * Lives in `@ifc-lite/data` rather than `@ifc-lite/ifcx`, which is the
 * semantically obvious home, for a dependency reason: `@ifc-lite/export` needs
 * it and depends on `data` but not on `ifcx`, and pulling `ifcx` in would drag
 * `pointcloud` + `laz-perf` into every consumer of the exporter for the sake of
 * one string. `@ifc-lite/ifcx` re-exports it, so importing it from there — the
 * obvious place to look — works too.
 *
 * The Rust exporter carries its own copy (`IFCX_VERSION` in
 * `rust/export/src/ifc5.rs`); the two are pinned together by the exportIfcx
 * assertion in `scripts/test-wasm-contract.mjs`, which reads the header out of
 * a real Rust-produced file.
 */
export const IFCX_VERSION = 'ifcx_alpha';
