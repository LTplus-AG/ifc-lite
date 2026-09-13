// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #960 — House.ifc walls clipped by a segmented roof via deeply-nested
//! `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
//! chains.
//!
//! Two distinct defects, both fixed by the chain-union path in
//! `BooleanClippingProcessor` (see `try_union_polygonal_chain`):
//!
//!   1. **Missing walls.** Walls clipped by 12–13 roof planes exceeded the
//!      `MAX_BOOLEAN_DEPTH` recursion limit, so processing returned `Err` and
//!      the wall rendered as *nothing*. (#4148, #2797, #5904.)
//!   2. **Seam slivers.** Sequentially subtracting abutting roof-segment
//!      prisms left a zero-thickness, full-height fin on the shared seam —
//!      a thin wall sliver poking *through* the roof (the original extrusion
//!      reached z = 9.85 m instead of the gable line). (#2152, #4374.)
//!
//! The fixture is a minimal transitive-closure extract of the five reported
//! walls from House.ifc (GitHub issue #960), fetched via `pnpm fixtures`
//! (sha256 in `tests/models/manifest.json`). Expected Z bounds are
//! IfcOpenShell's (pip 0.8.2, `use-world-coords`) — verified mm-identical to
//! both the full model and this extract. Coordinates are millimetres; the test
//! processes each wall at unit scale 1.0.
//!
//! The chain-union fix subtracts ONE watertight union of the cutter prisms.
//! `build_cutter_union` produces that union with the pure-Rust kernel's N-ary
//! union (`kernel::mesh_bridge::union_many` → `arrangement::union_all`): all
//! cutter prisms are conformed in ONE arrangement, so coplanar seams shared by
//! 3+ roof segments — and exactly-duplicated cutter prisms — dissolve into a
//! watertight solid. The pure-Rust exact kernel is the only kernel, so
//! this test runs unconditionally.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

mod support;

const FIXTURE: &str = "issues/960_house_segmented_roof_clip.ifc";

/// Read a `tests/models/` fixture, returning `None` (skip the test) when it is
/// absent or still an LFS pointer — unless `IFC_LITE_REQUIRE_FIXTURES=1` (set
/// by CI's `csg-accept-gates` job after it fetches and verifies the corpus),
/// in which case a missing fixture is a hard `panic!` instead: this test's
/// pinned Z-bound assertions below never ran without the fixture, and CI must
/// not report that as a pass. Local `cargo test` without the flag stays green
/// on a fresh clone as before.
fn read_fixture() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models")
        .join(FIXTURE);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            assert!(
                !support::require_fixtures(),
                "fixture {FIXTURE} is an LFS pointer and IFC_LITE_REQUIRE_FIXTURES=1 — \
                 run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)"
            );
            eprintln!("skipping: fixture {FIXTURE} is an LFS pointer — run `pnpm fixtures`");
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            assert!(
                !support::require_fixtures(),
                "fixture {FIXTURE} not present and IFC_LITE_REQUIRE_FIXTURES=1 — \
                 run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)"
            );
            eprintln!("skipping: fixture {FIXTURE} not present — run `pnpm fixtures`");
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Build the host→openings void index the same way production does.
fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

#[test]
fn segmented_roof_walls_render_without_slivers_or_drops() {
    let Some(content) = read_fixture() else {
        return;
    };
    let void_index = build_void_index(&content);
    let entity_index = build_entity_index(&content);

    // (express_id, GlobalId, expected world Z min/max in mm per IfcOpenShell)
    let cases = [
        (2152u32, "2FzACFrWn78vGKEK4Md6ha", 2850.0f32, 7325.0f32),
        (4374, "2PDtSyZL10pweyEST_guOH", 2850.0, 7348.0),
        (4148, "0wFZS1FlX4uQG90eXr1foJ", 2850.0, 8984.0),
        (2797, "1NKEanv7HDEOdbfk8nuT6f", 2850.0, 6593.0),
        (5904, "2l9upSYxz4xfNDmVZnFjG3", 2850.0, 8984.0),
    ];

    // 25 mm tolerance: the fix matches IfcOpenShell to ~1 mm; the regressions it
    // guards against are gross (a ~2.5 m sliver, or a fully empty mesh).
    let tol = 25.0_f32;

    #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
    let mut gated_regressions: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for (id, gid, want_zmin, want_zmax) in cases {
        let mut decoder = EntityDecoder::with_index(&content, entity_index.clone());
        let entity = decoder.decode_by_id(id).expect("decode wall");
        let router = GeometryRouter::with_scale(1.0);
        let mesh = router
            .process_element_with_voids(&entity, &mut decoder, &void_index)
            .unwrap_or_default();

        assert!(
            !mesh.is_empty(),
            "#{id} ({gid}) rendered as EMPTY — the boolean-clip chain was dropped \
             (depth limit). Expected a clipped wall up to z={want_zmax} mm.",
        );

        let (mn, mx) = mesh.bounds();
        // #3440/#3871: an accept gate could reject the roof clip's kernel
        // result on one of these five walls, and `try_union_polygonal_chain`
        // would then treat the gate's un-cut fallback as a valid answer
        // instead of deferring to the sequential per-cutter path — regrowing
        // the very seam sliver this test exists to catch. Fixed in #3919 by
        // having that function check `has_accept_gate_rejection_since` (both
        // on the unioned-cutter subtract and on each per-cutter trial) and
        // defer whenever a gate fired, exactly like a kernel error.
        //
        // Measured history (a value moving here means the gate or the fallback
        // moved and needs re-measuring, not re-pinning):
        //   - before #3912: #2152 read 9850 mm against its 7325 mm bar under
        //     EACH gate alone and under both; the other four unchanged.
        //   - after #3912 (the N-ary union weld, 2026-09-04) and before the
        //     #3919 fallback fix: under `csg_manifold_gate` alone #2152 was
        //     back on its bar and #5904 read 9850 mm against its 8984 mm bar
        //     instead; under `csg_topology_gate` (alone or with the manifold
        //     gate) BOTH #2152 and #5904 read 9850.
        //   - after the #3919 fallback fix: no wall regresses under any gate
        //     combination — the accept gates reject #5904's (and previously
        //     #2152's) unioned-cutter subtract exactly as before, but the
        //     chain now defers to the sequential per-cutter path instead of
        //     accepting the un-cut fallback, and that path lands every wall
        //     on its real bar. The gated pin is the exact set of walls that
        //     regress, asserted after the loop.
        #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
        if (id == 2152 || id == 5904) && (mx.z - 9850.0).abs() < tol {
            gated_regressions.insert(id);
            continue;
        }
        assert!(
            (mx.z - want_zmax).abs() < tol,
            "#{id} ({gid}) max Z = {:.0} mm, expected ~{want_zmax} mm. A value near \
             9850 means a full-height seam sliver survived the roof clip.",
            mx.z,
        );
        assert!(
            (mn.z - want_zmin).abs() < tol,
            "#{id} ({gid}) min Z = {:.0} mm, expected ~{want_zmin} mm.",
            mn.z,
        );
    }
    #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
    let expected_regressions: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
    assert_eq!(
        gated_regressions, expected_regressions,
        "the walls on which the accept gate lets the fallback regrow the seam \
         sliver moved (#3919 pins {expected_regressions:?}); a different set means \
         the gate or the fallback moved and needs re-measuring, not re-pinning."
    );
}

/// Six times the boundary-area VECTOR of a triangle soup: `Σ (p1−p0)×(p2−p0)`
/// over every triangle, in `f64`.
///
/// By Stokes' theorem this sum depends only on the mesh's boundary loop(s),
/// not on the interior triangulation: every INTERNAL edge is walked once in
/// each direction by its two incident triangles and cancels exactly, so only
/// edges with no (or an unequal count of) opposite partner contribute. A
/// CLOSED surface has no boundary, so this is the zero vector regardless of
/// how many triangles it has (#4648's `6·V(o) = 6·V(0) − o·A` identity: a
/// reference-independent volume forces `A = 0`). A boundary loop that is a
/// hairline T-junction chain — the same edge walked out and back along a
/// vertex inserted mid-edge — also nets to the zero vector: the loop encloses
/// no area, forward and return segments cancelling exactly. Only a boundary
/// loop that actually bounds a hole (real missing material) contributes a
/// nonzero vector, equal to twice that hole's own (signed) area vector.
///
/// This is why `|A|` reads zero on the hairline T-junctions the pipeline
/// deliberately forgives by design (`csg::consolidate::conform` documents
/// exactly this) where an open-boundary-EDGE count cannot tell that apart
/// from a genuine hole.
///
/// **`A` is a NET, not a per-hole, measure.** It sums every boundary loop's
/// own area vector, so it distinguishes a hairline chain from a hole, but it
/// does NOT distinguish "no holes" from "multiple holes whose area vectors
/// happen to sum near zero" (two square holes of equal area on opposite
/// faces of a box, for instance — see
/// `boundary_area_vector_false_negative_on_cancelling_holes` below for a
/// worked case). Reading `|A| ~= 0` on a mesh therefore rules out any single
/// dominant hole or any set of holes whose area vectors do not
/// near-cancel; it does not by itself prove the mesh has NO missing
/// material.
fn boundary_area_vector6(mesh: &ifc_lite_geometry::Mesh) -> [f64; 3] {
    let mut a = [0.0f64; 3];
    for tri in mesh.indices.chunks_exact(3) {
        let v = |i: u32| {
            let i = i as usize * 3;
            [
                mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64,
            ]
        };
        let p0 = v(tri[0]);
        let p1 = v(tri[1]);
        let p2 = v(tri[2]);
        let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        a[0] += e1[1] * e2[2] - e1[2] * e2[1];
        a[1] += e1[2] * e2[0] - e1[0] * e2[2];
        a[2] += e1[0] * e2[1] - e1[1] * e2[0];
    }
    a
}

/// Twice the mesh's own surface area (`Σ |(p1−p0)×(p2−p0)|`), the scale
/// `boundary_area_vector6` is measured against below: `|A| / (2·area)` is the
/// hole's area as a FRACTION of the mesh's own surface, independent of the
/// wall's absolute size (a 1 mm² hole and a 1 mm² hole on a 10x bigger wall
/// must not read as the same severity).
fn twice_surface_area(mesh: &ifc_lite_geometry::Mesh) -> f64 {
    let mut s = 0.0f64;
    for tri in mesh.indices.chunks_exact(3) {
        let v = |i: u32| {
            let i = i as usize * 3;
            [
                mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64,
            ]
        };
        let p0 = v(tri[0]);
        let p1 = v(tri[1]);
        let p2 = v(tri[2]);
        let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        let cr = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        s += (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
    }
    s
}

/// Measures the #3980 cutter-union's net boundary-area vector against the
/// REAL accepted subtraction — the mesh production actually ships for these
/// five walls — rather than against `build_cutter_union`'s own nonemptiness
/// assumption.
///
/// #3997 measured that this union is exact-bit-closed on only 1 of 5 real
/// chains, and the accepted subtraction on only 3 of 5, using an
/// open-boundary-EDGE count. That count does not distinguish a genuine hole
/// from the hairline T-junction openness the pipeline's own consolidation
/// step (`csg::consolidate::conform`) is documented to forgive by design —
/// so it could not say whether the open edges it found mean incorrectly
/// retained/removed material, or just unmerged coincident boundaries with no
/// missing area.
///
/// `boundary_area_vector6` narrows that: it is the zero vector for both a
/// closed mesh and a hairline chain, and nonzero (twice the hole's own area
/// vector) for a single genuine hole. As its own doc comment above states,
/// it is a NET measure — it would also read near-zero if a mesh carried
/// multiple genuine holes whose area vectors happen to cancel, so a
/// negligible reading here rules out any single dominant hole or any
/// non-cancelling combination on these five real chains, but is not by
/// itself an unconditional proof of zero missing material. It is still a
/// meaningfully stronger, reference-independent signal than the edge count
/// #3997 used, which cannot even separate a hairline chain from a hole.
#[test]
fn segmented_roof_walls_boundary_area_vector_is_negligible() {
    let Some(content) = read_fixture() else {
        return;
    };
    let void_index = build_void_index(&content);
    let entity_index = build_entity_index(&content);

    let cases = [
        (2152u32, "2FzACFrWn78vGKEK4Md6ha"),
        (4374, "2PDtSyZL10pweyEST_guOH"),
        (4148, "0wFZS1FlX4uQG90eXr1foJ"),
        (2797, "1NKEanv7HDEOdbfk8nuT6f"),
        (5904, "2l9upSYxz4xfNDmVZnFjG3"),
    ];

    // The pipeline's own hairline tolerance (see `count_open_boundary_edges_at`
    // and its 0.1 mm grid) is a LENGTH; `|A|` is an AREA fraction, so a real
    // hole big enough to matter (say, larger than a 1 mm-wide hairline sliver
    // running the height of one of these ~4-8 m walls) reads many orders of
    // magnitude above float round-off. 1e-6 is generous headroom over the
    // f32-position / f64-accumulation noise floor measured on the DEFAULT
    // (no accept-gate feature) build below (worst case ~3e-8) while still
    // catching anything a human would call a hole.
    let max_hole_fraction = 1e-6_f64;

    // MEASURED, not assumed: with `csg_topology_gate` alone (a CI-only,
    // off-by-default-in-production accept gate — see its Cargo.toml doc
    // comment), the #3919 accept-gate rejects wall #2152's unioned-cutter
    // subtract and defers to the sequential per-cutter path, which here hits
    // the `#635` AABB-fallback branch (`[issue-635] AABB fallback used`,
    // printed below) for a full-cross-section cutter. That fallback's own
    // result carries a genuine — not hairline — 63 mm² opening on this
    // ~39 m² wall (`|A|` ~= 126.8, fraction ~= 1.63e-6): small enough that the
    // existing 25 mm Z-bounds pin above cannot see it, but a real hole per
    // this finer measure. It does NOT reproduce with `csg_manifold_gate`
    // alone, nor with both gates together (both measured at ~4e-9, same as
    // the default build) — so it is specific to `csg_topology_gate` alone
    // choosing that fallback for this wall, not a property of the union path
    // this issue is about. Since this gate combination never ships, this is
    // recorded as a MEASURED, pinned exception (moving it means the gate,
    // the fallback, or this wall's geometry moved and needs re-measuring),
    // not silently widened tolerance for the default path above.
    #[cfg(all(feature = "csg_topology_gate", not(feature = "csg_manifold_gate")))]
    let gated_exception = |id: u32| if id == 2152 { Some(2e-6_f64) } else { None };
    #[cfg(not(all(feature = "csg_topology_gate", not(feature = "csg_manifold_gate"))))]
    let gated_exception = |_id: u32| None::<f64>;

    for (id, gid) in cases {
        let mut decoder = EntityDecoder::with_index(&content, entity_index.clone());
        let entity = decoder.decode_by_id(id).expect("decode wall");
        let router = GeometryRouter::with_scale(1.0);
        let mesh = router
            .process_element_with_voids(&entity, &mut decoder, &void_index)
            .unwrap_or_default();
        assert!(!mesh.is_empty(), "#{id} ({gid}) rendered as EMPTY");

        let a = boundary_area_vector6(&mesh);
        let a_mag = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        let twice_area = twice_surface_area(&mesh);
        let fraction = if twice_area > 0.0 { a_mag / twice_area } else { 0.0 };

        eprintln!(
            "AUDIT3980-boundary-area #{id} ({gid}): tris={} |A|={a_mag:.6} mm^2 \
             2*surface_area={twice_area:.3} mm^2 hole_fraction={fraction:e}",
            mesh.indices.len() / 3,
        );

        let bound = gated_exception(id).unwrap_or(max_hole_fraction);
        assert!(
            fraction < bound,
            "#{id} ({gid}): boundary-area-vector fraction {fraction:e} exceeds \
             {bound:e} — this reads as a GENUINE hole (missing \
             material), not a forgiven hairline T-junction. |A|={a_mag} mm^2 \
             over 2*area={twice_area} mm^2.",
        );
        assert!(
            gated_exception(id).is_none() || fraction >= max_hole_fraction,
            "#{id} ({gid}) no longer needs its pinned gated exception \
             ({fraction:e} is back under {max_hole_fraction:e}); remove the \
             `gated_exception` entry rather than leaving it unexercised.",
        );
    }
}

/// Builds a unit cube (12 triangles, outward-wound) as a plain `(positions,
/// indices)` pair — enough for `boundary_area_vector6`/`twice_surface_area`,
/// which read only those two fields.
fn unit_cube_mesh() -> ifc_lite_geometry::Mesh {
    let corners: [[f32; 3]; 8] = [
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
    ];
    // Outward-wound quads (CCW seen from outside), split into two triangles.
    let quads: [[u32; 4]; 6] = [
        [0, 3, 2, 1], // bottom (z=0), normal -z
        [4, 5, 6, 7], // top (z=1), normal +z
        [0, 1, 5, 4], // front (y=0)
        [2, 3, 7, 6], // back (y=1)
        [1, 2, 6, 5], // right (x=1)
        [3, 0, 4, 7], // left (x=0)
    ];
    let mut indices = Vec::new();
    for q in &quads {
        indices.extend_from_slice(&[q[0], q[1], q[2], q[0], q[2], q[3]]);
    }
    ifc_lite_geometry::Mesh {
        positions: corners.into_iter().flatten().collect(),
        normals: vec![0.0; 24],
        indices,
        ..Default::default()
    }
}

/// Proof the metric itself discriminates real holes from forgiven hairline
/// openness — the claim the production test above rests on. Each case is a
/// MUTATION of the one before it: dropping a face is a genuine hole; folding
/// two coincident interior triangles back on themselves is a hairline
/// T-junction chain. If `boundary_area_vector6` could not tell them apart,
/// `segmented_roof_walls_boundary_area_vector_is_negligible` above would be
/// vacuous — passing on any mesh regardless of real defects.
#[test]
fn boundary_area_vector_discriminates_hole_from_hairline() {
    // Closed cube: A must be exactly the zero vector (no boundary at all).
    let cube = unit_cube_mesh();
    let a_closed = boundary_area_vector6(&cube);
    assert_eq!(a_closed, [0.0, 0.0, 0.0], "closed cube must read A = 0 exactly");

    // MUTATION 1 — drop the top face (2 triangles): a genuine 1x1 hole. `A`
    // must equal exactly twice that hole's own area vector, [0, 0, 2] (the
    // dropped face's normal is +z, area 1, so 2x is [0,0,2]) — not merely
    // "nonzero".
    let mut holed = cube.clone();
    holed.indices.drain(6..12); // the "top" quad is the second of the six (indices [6,12))
    let a_hole = boundary_area_vector6(&holed);
    let a_hole_mag = (a_hole[0] * a_hole[0] + a_hole[1] * a_hole[1] + a_hole[2] * a_hole[2]).sqrt();
    assert!(
        (a_hole[0]).abs() < 1e-9 && (a_hole[1]).abs() < 1e-9 && (a_hole[2].abs() - 2.0).abs() < 1e-9,
        "dropping the top face must read A ~= [0,0,+-2] (twice its area vector, \
         sign set by the loop's winding), got {a_hole:?}"
    );
    let twice_area_hole = twice_surface_area(&holed);
    let fraction_hole = a_hole_mag / twice_area_hole;
    assert!(
        fraction_hole > 0.19,
        "a 1x1 hole on a 5-face-remaining cube must read as a LARGE fraction \
         (~0.2), got {fraction_hole}"
    );

    // MUTATION 2 — instead of dropping the top face, fold it: replace it with
    // TWO triangles that trace the same quad out and immediately back
    // (0,4,5 then 5,4,0 — the reverse winding of the same triangle), the
    // hairline "walked out and back" shape #4648/#3980 describe. The mesh is
    // still open (that folded pair is degenerate/non-manifold, not a real
    // face), but it encloses NO area, so `A` must read ~0 despite being open.
    let mut hairline = cube.clone();
    hairline.indices.extend_from_slice(&[4, 5, 6, 4, 6, 5]); // triangle then its exact reverse
    let a_hairline = boundary_area_vector6(&hairline);
    let a_hairline_mag =
        (a_hairline[0] * a_hairline[0] + a_hairline[1] * a_hairline[1] + a_hairline[2] * a_hairline[2])
            .sqrt();
    assert!(
        a_hairline_mag < 1e-9,
        "a degenerate out-and-back triangle pair encloses no area and must \
         read A ~= 0 despite being open, got |A|={a_hairline_mag}"
    );

    // If the discriminator degenerated to "always ~0" (the failure mode that
    // would make the production test above vacuous), MUTATION 1 above would
    // already have failed its fraction_hole > 0.19 assertion — this final
    // check makes that contrast explicit at the same scale.
    assert!(
        fraction_hole > 1000.0 * (a_hairline_mag / twice_surface_area(&hairline)).max(1e-15),
        "the genuine hole must read orders of magnitude larger than the \
         hairline case; hole={fraction_hole} hairline={}",
        a_hairline_mag / twice_surface_area(&hairline),
    );
}

/// Documents `boundary_area_vector6`'s known blind spot (raised in review of
/// #4679): it is a NET measure over every boundary loop, so it cannot tell
/// "no holes" apart from "multiple holes whose area vectors cancel." Drop
/// BOTH the top and bottom faces of the cube — two genuine, disjoint 1x1
/// holes totalling 2 units^2 of missing material — and `A` reads back
/// exactly zero, because the top hole's loop area vector ([0,0,+2]) and the
/// bottom hole's ([0,0,-2], the mirror-image loop on the opposite face) sum
/// to nothing.
///
/// This is why `segmented_roof_walls_boundary_area_vector_is_negligible`'s
/// negligible reading on the five real #960 walls is stated there as ruling
/// out a single dominant hole or any non-cancelling combination, not as an
/// unconditional proof of zero missing material: this test is the worked
/// case that shows why the stronger claim would not hold in general.
#[test]
fn boundary_area_vector_false_negative_on_cancelling_holes() {
    let cube = unit_cube_mesh();

    // Top quad is indices [6,12), bottom quad is indices [0,6) (see
    // `unit_cube_mesh`'s `quads` ordering: bottom first, then top).
    let mut two_holes = cube.clone();
    two_holes.indices.drain(6..12); // drop top face
    two_holes.indices.drain(0..6); // drop bottom face

    let a = boundary_area_vector6(&two_holes);
    let a_mag = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    assert!(
        a_mag < 1e-9,
        "two opposite holes with cancelling area vectors must read A ~= 0 \
         despite 2 units^2 of real missing material — got |A|={a_mag}, A={a:?}. \
         If this fails, the cube's quad winding changed and the cancellation \
         claim above needs re-deriving, not the test loosening."
    );

    // The two-holes mesh is genuinely NOT closed (dropping two of six faces
    // leaves an open tube), so the false negative is real, not a mislabeled
    // closed shape.
    assert!(
        two_holes.indices.len() < cube.indices.len(),
        "sanity: the two-holes mesh must have fewer triangles than the closed cube"
    );
}

/// Non-vacuousness proof for the PRODUCTION test above, on REAL data: take
/// wall #4374's actual accepted-subtraction mesh and mutate it by dropping
/// one triangle (the cheapest possible "the boolean under-removed / a real
/// hole opened" defect), then confirm the SAME assertion the production test
/// runs would catch it. This is the probe that proves a future regression
/// this shape would actually redden the test above, not just the synthetic
/// cube case.
///
/// Wall #4374, not #2152: #2152 carries the pinned, measured
/// `csg_topology_gate`-alone exception in the production test above (its own
/// doc comment there has the numbers), so asserting "starts under the gate"
/// on #2152 would itself be gate-dependent. #4374 measures exactly 0 under
/// every gate combination (see the `AUDIT3980-boundary-area` output above),
/// so this probe is unconditional.
#[test]
fn dropping_one_triangle_from_the_real_wall_mesh_reddens_the_gate() {
    let Some(content) = read_fixture() else {
        return;
    };
    let void_index = build_void_index(&content);
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index.clone());
    let entity = decoder.decode_by_id(4374).expect("decode wall #4374");
    let router = GeometryRouter::with_scale(1.0);
    let mut mesh = router
        .process_element_with_voids(&entity, &mut decoder, &void_index)
        .unwrap_or_default();
    assert!(!mesh.is_empty());

    let max_hole_fraction = 1e-6_f64;
    let before = {
        let a_mag = {
            let a = boundary_area_vector6(&mesh);
            (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
        };
        a_mag / twice_surface_area(&mesh)
    };
    assert!(before < max_hole_fraction, "sanity: real mesh must start under the gate");

    // Drop one interior triangle — a real hole exactly the size of that
    // triangle. Removed from the middle of the index buffer so no boundary
    // simplification could special-case "the last triangle".
    let mid = mesh.indices.len() / 6 * 3; // a triangle-aligned offset near the middle
    mesh.indices.drain(mid..mid + 3);

    let a = boundary_area_vector6(&mesh);
    let a_mag = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    let fraction = a_mag / twice_surface_area(&mesh);
    assert!(
        fraction >= max_hole_fraction,
        "dropping a real triangle from wall #4374's shipped mesh must exceed \
         the production gate's threshold ({max_hole_fraction:e}); got {fraction:e} \
         — if this fails, the gate above would NOT catch this class of defect."
    );
}
