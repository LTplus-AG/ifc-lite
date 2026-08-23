// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the batch partition's routing rules.
//!
//! The recurring shape these guard against is a fixture that cannot observe
//! the rule: one mesh, or meshes that are all alike, satisfies a batching gate
//! no matter what the gate says. So every count fixture below mixes group
//! sizes, and the threshold is probed at exactly `INSTANCE_MIN_OCCURRENCES`
//! and at one below — a group of "clearly many" would pass an off-by-one gate.

use super::*;
use ifc_lite_geometry::InstanceMeta;
use ifc_lite_processing::{MeshData, MeshTextureData};

/// An opaque, untextured, ordinary-occurrence mesh with no instance metadata:
/// the baseline every case below perturbs in exactly one respect.
fn plain_mesh() -> MeshData {
    MeshData::new(
        1,
        "IfcWall".to_string(),
        vec![0.0, 0.0, 0.0],
        vec![0.0, 0.0, 1.0],
        vec![0],
        [0.5, 0.5, 0.5, 1.0],
    )
}

fn meta(rep_identity: u128, instanceable: bool) -> InstanceMeta {
    InstanceMeta {
        transform: [0.0; 16],
        local_transform: None,
        canonical_transform: None,
        rep_identity,
        instanceable,
    }
}

fn mesh_with(rep_identity: u128, instanceable: bool) -> MeshData {
    plain_mesh().with_instance(Some(meta(rep_identity, instanceable)))
}

fn textured() -> MeshTextureData {
    MeshTextureData {
        texture_id: 7,
        rgba: None,
        width: 1,
        height: 1,
        url: Some("t.png".to_string()),
        repeat_s: true,
        repeat_t: true,
    }
}

// ───────────────────────────────────────────────────────────────────────────
// is_instancing_candidate — the per-mesh gate
// ───────────────────────────────────────────────────────────────────────────

/// Alpha is compared at a cutoff, so the informative fixtures are AT it and
/// just under it. "Fully opaque vs fully transparent" passes with the
/// comparison flipped to `>` or the cutoff moved anywhere in (0, 1).
#[test]
fn the_alpha_gate_admits_exactly_the_cutoff_and_rejects_just_under() {
    let mut at_cutoff = plain_mesh();
    at_cutoff.color[3] = INSTANCED_ALPHA_CUTOFF;
    assert!(
        is_instancing_candidate(&at_cutoff),
        "alpha == the cutoff is opaque: the renderer's own split is `>=`, and \
         disagreeing sends the same mesh down two different pipelines"
    );

    let mut just_under = plain_mesh();
    just_under.color[3] = INSTANCED_ALPHA_CUTOFF - 0.01;
    assert!(
        !is_instancing_candidate(&just_under),
        "just below the cutoff is transparent and must stay on the flat path"
    );

    let mut fully_opaque = plain_mesh();
    fully_opaque.color[3] = 1.0;
    assert!(is_instancing_candidate(&fully_opaque));
}

/// The cutoff's VALUE, not just the sharpness of the boundary around it.
///
/// Every other test here spells the threshold as the constant, so all of them
/// stay green with it set to anything at all — and this one is a MIRROR of
/// `OPAQUE_ALPHA_CUTOFF` in `packages/renderer/src/overlay-routing.ts`, not a
/// free choice. If the two drift, the wasm partition calls a mesh opaque that
/// the renderer blends (or the reverse) and the same geometry takes two
/// incompatible pipelines.
#[test]
fn the_alpha_cutoff_still_mirrors_the_renderers_constant() {
    assert_eq!(
        INSTANCED_ALPHA_CUTOFF, 0.99,
        "must equal OPAQUE_ALPHA_CUTOFF in packages/renderer/src/overlay-routing.ts; \
         change both together or not at all"
    );
}

/// Alpha is `color[3]`, not any other lane. A grey fixture cannot see a gate
/// that reads `color[0]`, so this one makes the RGB lanes disagree with alpha
/// in both directions.
#[test]
fn the_alpha_gate_reads_the_alpha_lane_not_a_colour_lane() {
    let mut opaque_but_dark = plain_mesh();
    opaque_but_dark.color = [0.0, 0.1, 0.2, 1.0];
    assert!(
        is_instancing_candidate(&opaque_but_dark),
        "a black opaque mesh is still opaque"
    );

    let mut bright_but_transparent = plain_mesh();
    bright_but_transparent.color = [1.0, 1.0, 1.0, 0.3];
    assert!(
        !is_instancing_candidate(&bright_but_transparent),
        "a white translucent mesh is still transparent"
    );
}

#[test]
fn textured_meshes_are_never_candidates() {
    let mut mesh = plain_mesh();
    mesh.texture = Some(textured());
    assert!(
        !is_instancing_candidate(&mesh),
        "the instanced pipeline has no UV slot, so a textured mesh routed \
         there would render untextured"
    );
}

/// `geometry_class` 1 and 2 are type-product geometry, which the viewer's
/// Model/Types switch filters on the flat path only. Testing class 1 alone
/// would pass with the gate written `!= 1`.
#[test]
fn only_ordinary_occurrence_geometry_is_a_candidate() {
    for class in [1u8, 2u8] {
        let mut mesh = plain_mesh();
        mesh.geometry_class = class;
        assert!(
            !is_instancing_candidate(&mesh),
            "geometry_class {class} is type-product geometry: the instanced \
             path has no view-mode filter, so it would draw unconditionally"
        );
    }
    let mut occurrence = plain_mesh();
    occurrence.geometry_class = 0;
    assert!(is_instancing_candidate(&occurrence));
}

/// The candidate gate is about the mesh's own properties. Instance metadata
/// decides repetition, not eligibility — so a candidate with no metadata is
/// still a candidate (it just tallies nothing and lands on the flat path).
#[test]
fn candidacy_does_not_depend_on_instance_metadata() {
    assert!(is_instancing_candidate(&plain_mesh()));
    assert!(is_instancing_candidate(&mesh_with(9, false)));
}

// ───────────────────────────────────────────────────────────────────────────
// tallyable_rep — what may inflate a group count
// ───────────────────────────────────────────────────────────────────────────

/// The three metadata states must give three different answers. A fixture with
/// only "has metadata" vs "has none" cannot see `instanceable` being ignored.
#[test]
fn only_instanceable_metadata_contributes_to_the_tally() {
    assert_eq!(tallyable_rep(&mesh_with(42, true)), Some(42));
    assert_eq!(
        tallyable_rep(&mesh_with(42, false)),
        None,
        "a void-cut or multi-item mesh can never instance, so it must not \
         inflate the count that sends its lookalikes to a shared template"
    );
    assert_eq!(tallyable_rep(&plain_mesh()), None, "no metadata, no tally");
}

// ───────────────────────────────────────────────────────────────────────────
// meets_instance_threshold — the per-batch repetition gate
// ───────────────────────────────────────────────────────────────────────────

/// Build the tally the partition builds: candidates only, instanceable only.
fn tally(meshes: &[MeshData]) -> rustc_hash::FxHashMap<u128, u32> {
    let mut counts: rustc_hash::FxHashMap<u128, u32> = rustc_hash::FxHashMap::default();
    for m in meshes {
        if is_instancing_candidate(m) {
            if let Some(rep) = tallyable_rep(m) {
                *counts.entry(rep).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// Exactly at the threshold passes, one below does not. Both groups are in the
/// SAME batch with DIFFERENT sizes: a batch holding one group of one size
/// cannot tell a `>=` gate from a `>` one, nor a gate reading the wrong key.
#[test]
fn the_repetition_gate_is_inclusive_at_the_threshold() {
    const AT: u128 = 100;
    const UNDER: u128 = 200;
    let mut meshes: Vec<MeshData> = Vec::new();
    for _ in 0..INSTANCE_MIN_OCCURRENCES {
        meshes.push(mesh_with(AT, true));
    }
    for _ in 0..(INSTANCE_MIN_OCCURRENCES - 1) {
        meshes.push(mesh_with(UNDER, true));
    }
    let counts = tally(&meshes);
    assert_eq!(counts.get(&AT), Some(&INSTANCE_MIN_OCCURRENCES));
    assert_eq!(counts.get(&UNDER), Some(&(INSTANCE_MIN_OCCURRENCES - 1)));

    assert!(
        meets_instance_threshold(&mesh_with(AT, true), &counts),
        "a group of exactly INSTANCE_MIN_OCCURRENCES is instanced"
    );
    assert!(
        !meets_instance_threshold(&mesh_with(UNDER, true), &counts),
        "one short of the threshold stays flat"
    );
}

/// A group that reaches the threshold only by counting meshes that cannot
/// instance must NOT pass: seven real occurrences plus one un-instanceable
/// lookalike is seven, not eight.
#[test]
fn un_instanceable_lookalikes_do_not_push_a_group_over_the_threshold() {
    const REP: u128 = 300;
    let mut meshes: Vec<MeshData> = Vec::new();
    for _ in 0..(INSTANCE_MIN_OCCURRENCES - 1) {
        meshes.push(mesh_with(REP, true));
    }
    meshes.push(mesh_with(REP, false));
    assert_eq!(
        meshes.len() as u32,
        INSTANCE_MIN_OCCURRENCES,
        "the fixture really does hold threshold-many meshes of this rep"
    );

    let counts = tally(&meshes);
    assert_eq!(counts.get(&REP), Some(&(INSTANCE_MIN_OCCURRENCES - 1)));
    assert!(!meets_instance_threshold(&mesh_with(REP, true), &counts));
}

/// Transparent and textured meshes share their rep_identity with the opaque
/// ones, so a tally that counted every mesh instead of every CANDIDATE would
/// read the same number here — and route the group to a shard the transparent
/// members cannot join.
#[test]
fn non_candidate_meshes_do_not_inflate_the_tally() {
    const REP: u128 = 400;
    let mut meshes: Vec<MeshData> = Vec::new();
    for _ in 0..(INSTANCE_MIN_OCCURRENCES - 2) {
        meshes.push(mesh_with(REP, true));
    }
    let mut glass = mesh_with(REP, true);
    glass.color[3] = 0.4;
    meshes.push(glass);
    let mut tiled = mesh_with(REP, true);
    tiled.texture = Some(textured());
    meshes.push(tiled);

    let counts = tally(&meshes);
    assert_eq!(
        counts.get(&REP),
        Some(&(INSTANCE_MIN_OCCURRENCES - 2)),
        "the glass and the textured mesh must not be counted"
    );
    assert!(!meets_instance_threshold(&mesh_with(REP, true), &counts));
}

/// The gate reads the tally through the mesh's OWN rep key. A batch with a
/// single rep cannot observe a gate that reads any-group-passes.
#[test]
fn the_gate_reads_the_meshs_own_rep_group() {
    const BIG: u128 = 500;
    const SMALL: u128 = 600;
    let mut meshes: Vec<MeshData> = Vec::new();
    for _ in 0..(INSTANCE_MIN_OCCURRENCES * 3) {
        meshes.push(mesh_with(BIG, true));
    }
    meshes.push(mesh_with(SMALL, true));
    let counts = tally(&meshes);

    assert!(meets_instance_threshold(&mesh_with(BIG, true), &counts));
    assert!(
        !meets_instance_threshold(&mesh_with(SMALL, true), &counts),
        "a singleton stays flat even when another group in the batch is huge"
    );
    assert!(
        !meets_instance_threshold(&mesh_with(999, true), &counts),
        "a rep absent from the tally counts as zero, never as 'unknown, allow'"
    );
    assert!(
        !meets_instance_threshold(&mesh_with(BIG, false), &counts),
        "an un-instanceable mesh never instances, whatever its group's count"
    );
}

// ───────────────────────────────────────────────────────────────────────────
// style_colors_from_wire — the prepass style wire decode
// ───────────────────────────────────────────────────────────────────────────

/// Stride and lane order in one fixture: three styles, every one of the twelve
/// bytes distinct, so reading stride 3, or transposing r/b, or shifting by one
/// lane all land on a different number.
#[test]
fn each_style_reads_its_own_four_bytes_in_rgba_order() {
    let ids = [10u32, 20, 30];
    let bytes: Vec<u8> = vec![
        0, 51, 102, 153, // id 10
        204, 255, 17, 34, // id 20
        68, 85, 119, 136, // id 30
    ];
    let map = style_colors_from_wire(&ids, &bytes);

    assert_eq!(map.len(), 3);
    let close = |a: f32, b: f32| (a - b).abs() < 1e-6;
    let c10 = map[&10];
    assert!(close(c10[0], 0.0) && close(c10[1], 51.0 / 255.0));
    assert!(close(c10[2], 102.0 / 255.0) && close(c10[3], 153.0 / 255.0));
    let c20 = map[&20];
    assert!(
        close(c20[0], 204.0 / 255.0) && close(c20[3], 34.0 / 255.0),
        "style 20's colour starts at byte 4, not byte 3"
    );
    let c30 = map[&30];
    assert!(
        close(c30[0], 68.0 / 255.0) && close(c30[3], 136.0 / 255.0),
        "style 30's colour starts at byte 8"
    );
}

/// 255 must land on exactly 1.0 — the divisor is 255, not 256, and a fully
/// saturated channel that arrives as 0.996 is a visible colour shift that a
/// tolerance-based assertion would wave through.
#[test]
fn a_full_byte_is_exactly_one() {
    let map = style_colors_from_wire(&[1], &[255, 0, 255, 255]);
    assert_eq!(
        map[&1],
        [1.0, 0.0, 1.0, 1.0],
        "255/255 is exactly 1.0; 255/256 would be 0.99609"
    );
}

/// The length guard is inclusive of the last byte: four bytes is a complete
/// style, three is not. Testing only a wildly short buffer would pass with the
/// comparison off by one in either direction.
#[test]
fn a_style_is_kept_only_when_all_four_of_its_bytes_are_present() {
    assert_eq!(
        style_colors_from_wire(&[1], &[1, 2, 3, 4]).len(),
        1,
        "exactly four bytes is one complete style"
    );
    assert!(
        style_colors_from_wire(&[1], &[1, 2, 3]).is_empty(),
        "three bytes cannot make an RGBA quad"
    );
}

/// A short tail costs the styles it truncates their colour and nothing else —
/// the complete ones ahead of it still decode. Two styles with only one
/// complete is the case that separates "drop the tail" from "drop everything"
/// and from "read past the end".
#[test]
fn a_truncated_wire_keeps_the_complete_styles_ahead_of_the_tail() {
    let map = style_colors_from_wire(&[10, 20], &[255, 255, 255, 255, 1, 2]);
    assert_eq!(map.len(), 1, "style 20's quad is incomplete");
    assert!(map.contains_key(&10), "style 10's quad is complete");
    assert!(!map.contains_key(&20));
}

#[test]
fn an_empty_wire_decodes_to_an_empty_map() {
    assert!(style_colors_from_wire(&[], &[]).is_empty());
    assert!(
        style_colors_from_wire(&[1, 2], &[]).is_empty(),
        "ids with no colour bytes at all yield nothing, not black"
    );
}
