// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-output determinism manifest - wasm32 leg.
//!
//! Runs THE SAME battery as the native test
//! (`rust/processing/tests/mesh_determinism.rs`): both call
//! `ifc_lite_processing::determinism::compute_mesh_manifest()`, so fixture and
//! hashing cannot drift between the two legs. It asserts the pinned WASM32
//! manifest, which differs from the native one in EXACTLY the documented
//! libm-trig gap (mesh #500's smooth radial normals carry sin/cos ULP
//! residue in near-zero components; positions are byte-identical) - the
//! native test's `wasm_manifest_differs_only_in_the_trig_gap` guard pins that
//! the two files never drift further apart than that.
//!
//! Run: `wasm-pack test --node rust/wasm-bindings --test mesh_determinism`
//! (wired into .github/workflows/determinism.yml).
//! Contract: docs/architecture/mesh-determinism.md
#![cfg(target_arch = "wasm32")]

use ifc_lite_processing::determinism::{compute_mesh_manifest, diff_report, MeshManifest};
use wasm_bindgen_test::wasm_bindgen_test;

/// Pinned wasm32 manifest (compile-time embed, so the wasm bundle needs no
/// filesystem). Byte-identical to the native manifest except the trig gap.
const PINNED_MANIFEST_JSON: &str =
    include_str!("../../processing/tests/manifests/mesh_determinism.wasm32.json");

#[wasm_bindgen_test]
fn mesh_output_matches_pinned_manifest_on_wasm32() {
    let expected = MeshManifest::from_json(PINNED_MANIFEST_JSON).expect(
        "rust/processing/tests/manifests/mesh_determinism.wasm32.json is not valid manifest JSON",
    );
    let actual = compute_mesh_manifest();
    if let Some(report) = diff_report(&expected, &actual) {
        panic!(
            "wasm32 mesh output diverged from the pinned wasm32 manifest \
             (see docs/architecture/mesh-determinism.md):\n{report}\n\n\
             actual wasm32 manifest JSON (re-pin \
             tests/manifests/mesh_determinism.wasm32.json ONLY if the geometry \
             change is intended, and keep the native manifest in lockstep):\n{}",
            actual.to_json()
        );
    }
}
