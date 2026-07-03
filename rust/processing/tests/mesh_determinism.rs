// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-output determinism manifest - native leg.
//!
//! Asserts the committed manifest (`tests/manifests/mesh_determinism.json`)
//! byte-for-byte against [`ifc_lite_processing::determinism`]'s battery: the
//! full `process_geometry` pipeline at Medium tessellation with the
//! local-frame flag forced ON (equalized with the wasm default, see the
//! harness doc). The same manifest is asserted on arm64 by the determinism
//! workflow, and the wasm leg (`rust/wasm-bindings/tests/mesh_determinism.rs`)
//! asserts the paired `mesh_determinism.wasm32.json` - identical except the
//! documented trig gap, pinned by `wasm_manifest_differs_only_in_the_trig_gap`
//! below. A mismatch anywhere means mesh output diverged across targets or
//! across time: a real determinism regression, or an intended geometry change
//! that must re-pin the manifest pair.
//!
//! Re-pin: run with `--nocapture`, copy the "actual manifest JSON" block the
//! failure prints into `tests/manifests/mesh_determinism.json`, and re-run the
//! wasm leg to re-pin its file the same way.
//! Contract: docs/architecture/mesh-determinism.md

use ifc_lite_processing::determinism::{compute_mesh_manifest, diff_report, MeshManifest};

const PINNED_MANIFEST_JSON: &str = include_str!("manifests/mesh_determinism.json");
const PINNED_WASM32_MANIFEST_JSON: &str = include_str!("manifests/mesh_determinism.wasm32.json");

/// Express id of the round column - the ONE mesh whose bytes are allowed to
/// differ between the native and wasm32 manifests: its circle tessellation
/// runs libm sin/cos, whose ULP differences between platform libms survive in
/// the near-zero components of the smooth radial normals (positions are
/// byte-identical). See docs/architecture/mesh-determinism.md.
const TRIG_GAP_EXPRESS_ID: u32 = 500;

#[test]
fn mesh_output_matches_pinned_manifest() {
    let expected = MeshManifest::from_json(PINNED_MANIFEST_JSON)
        .expect("tests/manifests/mesh_determinism.json is not valid manifest JSON");
    let actual = compute_mesh_manifest();

    // Guard the fixture itself: the manifest is only worth its bytes if the
    // battery still exercises the void, multi-material and curved-profile
    // paths it was designed around, and if the sorted wire arrays keep >= 2
    // entries (a one-entry array pins no order).
    for id in [100u32, 400, 500, 600] {
        assert!(
            actual.meshes.iter().any(|m| m.express_id == id),
            "fixture rot: element #{id} produced no mesh"
        );
    }
    assert!(
        actual.void_host_count >= 2,
        "fixture rot: flat_voids has {} host(s); the sorted key order is only \
         load-bearing with at least 2",
        actual.void_host_count
    );
    assert!(
        actual.material_element_count >= 2,
        "fixture rot: flat_material_colors has {} element(s); the sorted id \
         order is only load-bearing with at least 2",
        actual.material_element_count
    );
    assert!(
        actual.style_entry_count >= 2,
        "fixture rot: flat_styles_rgba8 has {} entr(y/ies); the sorted id \
         order is only load-bearing with at least 2",
        actual.style_entry_count
    );

    if let Some(report) = diff_report(&expected, &actual) {
        panic!(
            "mesh-output determinism manifest mismatch (see \
             docs/architecture/mesh-determinism.md):\n{report}\n\n\
             actual manifest JSON (re-pin tests/manifests/mesh_determinism.json \
             ONLY if the geometry change is intended, then re-run the wasm leg):\n{}",
            actual.to_json()
        );
    }
}

/// The wasm32 manifest is the native manifest plus EXACTLY the documented
/// trig gap - nothing else may drift between the two files. When the gap
/// closes (deterministic trig in the circle tessellation path), this test
/// fails on purpose: unify the two manifests into one.
#[test]
fn wasm_manifest_differs_only_in_the_trig_gap() {
    let native = MeshManifest::from_json(PINNED_MANIFEST_JSON)
        .expect("tests/manifests/mesh_determinism.json is not valid manifest JSON");
    let wasm = MeshManifest::from_json(PINNED_WASM32_MANIFEST_JSON)
        .expect("tests/manifests/mesh_determinism.wasm32.json is not valid manifest JSON");

    assert_eq!(native.mesh_count, wasm.mesh_count, "manifest drift: mesh_count");
    assert_eq!(native.vertex_count, wasm.vertex_count, "manifest drift: vertex_count");
    assert_eq!(native.triangle_count, wasm.triangle_count, "manifest drift: triangle_count");
    // The prepass wire arrays are pure u32/rgba8 bytes - byte-identical across
    // targets, no trig exemption.
    assert_eq!(native.voids_hash, wasm.voids_hash, "manifest drift: voids_hash");
    assert_eq!(native.void_host_count, wasm.void_host_count, "manifest drift: void_host_count");
    assert_eq!(
        native.material_colors_hash, wasm.material_colors_hash,
        "manifest drift: material_colors_hash"
    );
    assert_eq!(
        native.material_element_count, wasm.material_element_count,
        "manifest drift: material_element_count"
    );
    assert_eq!(native.styles_hash, wasm.styles_hash, "manifest drift: styles_hash");
    assert_eq!(
        native.style_entry_count, wasm.style_entry_count,
        "manifest drift: style_entry_count"
    );

    assert_eq!(native.meshes.len(), wasm.meshes.len(), "manifest drift: mesh list length");
    let mut gap_meshes = 0usize;
    for (n, w) in native.meshes.iter().zip(wasm.meshes.iter()) {
        assert_eq!(n.express_id, w.express_id, "manifest drift: mesh emit order");
        assert_eq!(n.geometry_class, w.geometry_class, "manifest drift: geometry_class");
        assert_eq!(n.vertex_count, w.vertex_count, "manifest drift: per-mesh vertex_count");
        assert_eq!(n.triangle_count, w.triangle_count, "manifest drift: per-mesh triangle_count");
        // Positions AND identity/topology/origin are byte-identical on EVERY
        // mesh cross-target - including the curved column. This is the invariant
        // the hash split exists to enforce: the trig gap lives in the near-zero
        // radial-normal components, not in the (snapped) positions, so a future
        // change that diverged the curved mesh's positions across targets would
        // now fail here instead of hiding inside a combined per-mesh hash.
        assert_eq!(
            n.positions_hash, w.positions_hash,
            "manifest drift: mesh #{} POSITIONS differ between native and wasm32 \
             (positions must be byte-identical cross-target, curved mesh included)",
            n.express_id
        );
        assert_eq!(
            n.indices_origin_hash, w.indices_origin_hash,
            "manifest drift: mesh #{} indices/origin differ between native and wasm32",
            n.express_id
        );
        // Normals are the ONLY per-mesh surface allowed to differ, and only for
        // the curved-profile mesh whose radial normals carry the libm trig gap.
        if n.express_id == TRIG_GAP_EXPRESS_ID {
            if n.normals_hash != w.normals_hash {
                gap_meshes += 1;
            }
        } else {
            assert_eq!(
                n.normals_hash, w.normals_hash,
                "manifest drift: mesh #{} normals differ between native and wasm32 \
                 outside the documented trig gap",
                n.express_id
            );
        }
    }
    if gap_meshes == 0 {
        assert_eq!(
            native.hash, wasm.hash,
            "the trig gap appears closed (mesh #{TRIG_GAP_EXPRESS_ID} matches) but the \
             top-level hashes still differ - regenerate both manifests"
        );
        panic!(
            "the libm trig gap has closed: native and wasm32 manifests are identical. \
             Delete tests/manifests/mesh_determinism.wasm32.json, point the wasm leg at \
             the native manifest, and remove this guard's exemption."
        );
    }
}

#[test]
fn mesh_output_is_stable_across_reruns() {
    // In-process rerun sanity: two computes over the same bytes must agree
    // bit-for-bit (catches iteration-order or uninitialized-state leaks that
    // happen to match the pinned manifest on the first run).
    let first = compute_mesh_manifest();
    let second = compute_mesh_manifest();
    if let Some(report) = diff_report(&first, &second) {
        panic!("mesh output diverged between two in-process runs:\n{report}");
    }
}
