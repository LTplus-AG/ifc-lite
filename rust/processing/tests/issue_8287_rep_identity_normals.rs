// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #8287: two items whose local normals differ must not share
//! an instancing `rep_identity`. `ifc_lite_geometry::instancing`'s correctness
//! contract says why the key is the only place that difference can be caught.
//!
//! The fixture is the #8276 pair, two rectangular openings whose ring
//! coordinates differ by ~1e-15: byte-identical f32 positions and indices,
//! side-wall normals differing in the last bits.

mod f32_identical_openings;

use f32_identical_openings::{fixture_content, mesh_on_one_router, OPENING_A, OPENING_B};
use ifc_lite_geometry::{collate_refs, decode_instanced, encode_refs, InstanceMeshRef};
use ifc_lite_processing::MeshData;

/// A collation view over a produced mesh. `collate_refs` reads `instance_meta`
/// for the key and the pose, and the buffers for its shape guard.
fn as_ref(mesh: &MeshData) -> InstanceMeshRef<'_> {
    InstanceMeshRef {
        positions: &mesh.positions,
        normals: &mesh.normals,
        indices: &mesh.indices,
        origin: mesh.origin,
        instance_meta: mesh.instance.as_ref(),
        entity_id: mesh.express_id,
        color: mesh.color,
        item_id: mesh.geometry_item_id,
    }
}

/// Guards the premise: both openings are stamped instanceable, so a shared key
/// really does reach the grouping pass. A failure here means the fixture or
/// the capture rules moved, not that the defect is gone.
#[test]
fn both_openings_are_instanceable() {
    let content = fixture_content();
    let meshes = mesh_on_one_router(&content, &[OPENING_A, OPENING_B]);
    for (mesh, id) in meshes.iter().zip([OPENING_A, OPENING_B]) {
        let meta = mesh
            .instance
            .as_ref()
            .unwrap_or_else(|| panic!("#{id} carries no InstanceMeta"));
        assert!(meta.instanceable, "#{id} is not instanceable");
    }
}

/// THE REGRESSION. The two openings differ in their normals and in nothing
/// else, so they must not collate into one template — whichever of them became
/// the template would supply its normals to the other.
#[test]
fn normals_only_difference_does_not_group() {
    let content = fixture_content();
    let meshes = mesh_on_one_router(&content, &[OPENING_A, OPENING_B]);
    let (a, b) = (&meshes[0], &meshes[1]);

    // The pair this fixture exists to produce: same positions and indices,
    // different normals. Asserted here so a fixture that stopped colliding
    // fails loudly instead of passing the group assertion vacuously.
    assert_eq!(a.positions, b.positions, "fixture rot: the openings no longer share f32 positions");
    assert_eq!(a.indices, b.indices, "fixture rot: the openings no longer share indices");
    assert_ne!(a.normals, b.normals, "fixture rot: the openings no longer differ in their normals");

    let refs = vec![as_ref(a), as_ref(b)];
    let collated = collate_refs(&refs, 2, [0.0; 3]);

    assert!(
        collated.templates.is_empty(),
        "the two openings collated into {} template(s) with {} occurrence(s): the template's \
         normals ship to both, and which opening becomes the template decides whose normals \
         the other gets (#8287)",
        collated.templates.len(),
        collated.instanced_occurrence_count(),
    );
    assert_eq!(
        collated.flat_indices.len(),
        2,
        "both openings must be drawn flat once they cannot share a template",
    );
    assert_eq!(
        collated.verification_rejections, 0,
        "a rejected GROUP is not the fix: the pair must never share a key in the first place, \
         so no group exists to reject",
    );
}

/// What the group actually ships. `collate_refs` + `encode_refs` is the pair
/// the WASM batch path runs, and the shard carries ONE normals pool per
/// template, so this is the defect in the bytes a consumer receives rather
/// than in the grouping decision that causes it.
#[test]
fn each_opening_ships_its_own_normals() {
    let content = fixture_content();
    let meshes = mesh_on_one_router(&content, &[OPENING_A, OPENING_B]);
    let refs = vec![as_ref(&meshes[0]), as_ref(&meshes[1])];

    let shard = encode_refs(&refs, &collate_refs(&refs, 2, [0.0; 3]));
    let decoded = decode_instanced(&shard).expect("the shard this encoder just wrote decodes");

    for (id, want) in [(OPENING_A, &meshes[0]), (OPENING_B, &meshes[1])] {
        let occurrence = decoded
            .instances
            .iter()
            .find(|i| i.entity_id == id)
            .unwrap_or_else(|| panic!("#{id} has no occurrence in the shard"));
        let got = &decoded.templates[occurrence.template_index as usize].normals;
        assert_eq!(
            *got, want.normals,
            "#{id} was shipped another opening's normals (#8287)",
        );
    }
}
