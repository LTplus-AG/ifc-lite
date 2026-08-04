// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1985: the `IfcMappedItem` transform is `MappingTarget · MappingOrigin`.
//!
//! Both fixtures author their geometry in METRE numbers inside an
//! `IfcRepresentationMap` and instantiate it into a MILLIMETRE model through a
//! uniform `Scale = 1000` `IfcCartesianTransformationOperator3D` — the exact
//! shape reported in #1985.
//!
//! `scaled_kinds` pins the SCALE half: every mapped occurrence must land on the
//! same world geometry as the identical solid authored directly in millimetres.
//! `mapping_origin` pins the half that was actually broken: the map's
//! `MappingOrigin` (attr 0) was dropped everywhere in the mesh path, so a
//! non-identity origin placed the geometry at the wrong spot — and, being
//! composed INSIDE the target, its error was multiplied by the target scale
//! (1 m of origin became a 1 m miss here, but 0 m of movement before the fix).

use ifc_lite_processing::{
    process_geometry_streaming_filtered_with_options, MeshData, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn run(content: &[u8], instancing: bool) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions {
            enable_instancing: instancing,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// World-space AABB (`origin + position`, the renderer's reconstruction).
fn world_bounds(m: &MeshData) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in m.positions.chunks_exact(3) {
        for k in 0..3 {
            let w = m.origin[k] + v[k] as f64;
            min[k] = min[k].min(w);
            max[k] = max[k].max(w);
        }
    }
    (min, max)
}

fn mesh_by_id(res: &ProcessingResult, id: u32) -> &MeshData {
    res.meshes
        .iter()
        .find(|m| m.express_id == id)
        .unwrap_or_else(|| panic!("no mesh for #{id}"))
}

/// Model metres. The fixtures sit at single-metre coordinates, where f32
/// positions resolve far below this.
const TOL: f64 = 1e-4;

fn assert_close(actual: [f64; 3], expected: [f64; 3], what: &str) {
    for k in 0..3 {
        assert!(
            (actual[k] - expected[k]).abs() < TOL,
            "{what}: axis {k} was {}, expected {} (full {actual:?} vs {expected:?})",
            actual[k],
            expected[k]
        );
    }
}

/// A uniform `Scale = 1000` MappingTarget must reproduce the identical solid
/// authored directly in millimetres — for a swept profile, a swept disk, and a
/// faceted brep alike. (#1985 reported stretched pipes on such a file; this
/// pins that the scale itself is applied to all three axes at full precision.)
#[test]
fn uniform_scale_1000_matches_direct_millimetre_authoring() {
    let res = run(&fixture_bytes("issue_1985_scaled_kinds.ifc"), false);

    // #74 mapped extruded circle vs #99 the same circle authored in mm.
    // #81 mapped swept disk vs #109 the same disk authored in mm.
    // Each direct twin is offset +2 m in Y, so compare EXTENTS, not positions.
    for (mapped, direct, what) in [
        (74u32, 99u32, "extruded circle"),
        (81, 109, "swept disk"),
    ] {
        let (mmin, mmax) = world_bounds(mesh_by_id(&res, mapped));
        let (dmin, dmax) = world_bounds(mesh_by_id(&res, direct));
        let msize = [mmax[0] - mmin[0], mmax[1] - mmin[1], mmax[2] - mmin[2]];
        let dsize = [dmax[0] - dmin[0], dmax[1] - dmin[1], dmax[2] - dmin[2]];
        assert_close(msize, dsize, &format!("{what}: mapped size vs direct size"));
        assert_close(msize, [0.1, 0.1, 2.0], &format!("{what}: absolute size"));
        assert_eq!(
            mesh_by_id(&res, mapped).positions.len(),
            mesh_by_id(&res, direct).positions.len(),
            "{what}: mapped and direct must tessellate identically"
        );
    }

    // #88 faceted brep: a 1 m box authored as a unit box × Scale 1000.
    let (bmin, bmax) = world_bounds(mesh_by_id(&res, 88));
    assert_close(
        [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]],
        [1.0, 1.0, 1.0],
        "faceted brep size",
    );
}

/// The map's `MappingOrigin` is a +1 m (map units) Z offset, composed INSIDE a
/// `Scale = 1000` target, so both occurrences must sit at z ∈ [1, 3] m. Before
/// the fix the origin was ignored entirely and they sat at z ∈ [0, 2].
#[test]
fn mapping_origin_is_composed_inside_the_mapping_target() {
    for instancing in [false, true] {
        let res = run(&fixture_bytes("issue_1985_mapping_origin.ifc"), instancing);

        // Occurrence #40 is placed at the model origin; #47 at x = 1 m.
        let (min, max) = world_bounds(mesh_by_id(&res, 40));
        assert_close(min, [-0.05, -0.05, 1.0], "occurrence #40 min (instancing)");
        assert_close(max, [0.05, 0.05, 3.0], "occurrence #40 max (instancing)");

        if !instancing {
            let (min, max) = world_bounds(mesh_by_id(&res, 47));
            assert_close(min, [0.95, -0.05, 1.0], "occurrence #47 min");
            assert_close(max, [1.05, 0.05, 3.0], "occurrence #47 max");
            continue;
        }

        // With instancing on, #47 skips materialization and rides as an
        // InstanceRecord against the #40 template. Reconstruct it the way the
        // renderer and the GLB exporter do — template world vertices placed by
        // the record's mat4 — and assert the ABSOLUTE result.
        //
        // This is not redundant with the template assertion above: the record's
        // transform is `M_47 · M_40⁻¹`, so any error made SYMMETRICALLY in both
        // occurrences' `local_transform` (dropping MappingOrigin from both, say)
        // cancels here and would leave every instanced occurrence unpinned.
        // Asserting the absolute reconstruction catches the symmetric case,
        // because the template's own world geometry carries the origin.
        let record = res
            .instances
            .iter()
            .find(|i| i.express_id == 47)
            .expect("occurrence #47 should ride as an instance record");
        assert_eq!(record.template_express_id, 40, "template for #47");
        let template = mesh_by_id(&res, 40);
        let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for v in template.positions.chunks_exact(3) {
            let (x, y, z) = (
                template.origin[0] + v[0] as f64,
                template.origin[1] + v[1] as f64,
                template.origin[2] + v[2] as f64,
            );
            let t = record.transform.map(|c| c as f64);
            let w = [
                t[0] * x + t[1] * y + t[2] * z + t[3],
                t[4] * x + t[5] * y + t[6] * z + t[7],
                t[8] * x + t[9] * y + t[10] * z + t[11],
            ];
            let h = t[12] * x + t[13] * y + t[14] * z + t[15];
            for k in 0..3 {
                min[k] = min[k].min(w[k] / h);
                max[k] = max[k].max(w[k] / h);
            }
        }
        assert_close(min, [0.95, -0.05, 1.0], "instanced #47 reconstructed min");
        assert_close(max, [1.05, 0.05, 3.0], "instanced #47 reconstructed max");
    }
}

/// The scale directions the two fixtures above do not reach: a METRE model (unit
/// scale exactly 1.0, so nothing in the length-unit path can move the geometry)
/// whose map is authored in MILLIMETRE numbers and brought down by a
/// `Scale = 0.001` target — plus the non-uniform 3D operator and a NESTED map,
/// each of which composes a second transform inside the first.
///
/// #1985's reporter later narrowed their file to `IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`
/// with a pipe whose `Length` property reads `1734.50 mm`; the fixture uses those
/// exact numbers so a dropped or doubled 1000× would be unmissable.
#[test]
fn sub_unit_scales_nonuniform_and_nested_maps_match_direct_metre_authoring() {
    for instancing in [false, true] {
        let res = run(&fixture_bytes("issue_1985_metre_submm_scale.ifc"), instancing);
        let size = |id: u32| {
            let (min, max) = world_bounds(mesh_by_id(&res, id));
            [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
        };

        // #99: the pipe authored directly in metres — the reference.
        assert_close(size(99), [0.1, 0.1, 1.7345], "direct metre pipe");
        // #74: mm-authored map, uniform Scale = 0.001.
        assert_close(size(74), size(99), "uniform 0.001 vs direct");
        // #88: the same map reached through a NESTED IfcMappedItem — inner
        // Scale = 0.001 composed inside an outer Scale = 1.
        assert_close(size(88), size(99), "nested map vs direct");
        // #81: IfcCartesianTransformationOperator3DnonUniform (0.001, 0.001,
        // 0.002) — Z twice the others, so an operator that collapsed to its X
        // scale (or read Scale3 from the wrong attribute) halves this.
        assert_close(size(81), [0.1, 0.1, 3.469], "non-uniform 3D operator");
    }
}
