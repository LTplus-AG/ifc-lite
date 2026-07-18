// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" byte-identity gate.
//!
//! Runs the REAL geometry pipeline twice on an `IfcMappedItem`-heavy model:
//!   * flat (`enable_instancing = false`) — every occurrence materializes;
//!   * instanced (`enable_instancing = true`) — repeated single-solid sources mesh
//!     ONCE (a template occurrence) and every other occurrence becomes an
//!     `InstanceRecord`.
//!
//! It then proves the instanced output reproduces the flat output's WORLD TRIANGLES
//! bit-for-bit within a micrometre: for each occurrence,
//! `rel_k · (template.origin + template.positions)` equals the flat occurrence's baked
//! world vertices. This is the hard correctness gate — the ONLY intended change on the
//! instanced path is WHICH occurrence carries the geometry, never a world triangle.

use ifc_lite_processing::{
    process_geometry_streaming_filtered_with_options, InstanceRecord, MeshData, OpeningFilterMode,
    ProcessingResult, StreamingOptions,
};
use rustc_hash::FxHashMap;

/// A real repeated-`IfcMappedItem` sample (hello-wall: three RepresentationMaps).
fn sample_bytes() -> Vec<u8> {
    let path = format!(
        "{}/../../apps/viewer/public/samples/hello-wall.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// A synthetic model: ONE single-solid `IfcRepresentationMap` instanced by 64
/// `IfcBuildingElementProxy` occurrences at distinct placements — exercises the
/// don't-bake path at scale (63 skipped materializes, one template).
fn synthetic_bytes() -> Vec<u8> {
    fixture_bytes("mapped_instances_synthetic.ifc")
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn run(content: &[u8], enable_instancing: bool) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions {
            enable_instancing,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// World vertices of a mesh = `origin + position` per vertex (the renderer's
/// reconstruction), as an `f64` triple list.
fn world_vertices(m: &MeshData) -> Vec<[f64; 3]> {
    let n = m.positions.len() / 3;
    (0..n)
        .map(|v| {
            [
                m.origin[0] + m.positions[v * 3] as f64,
                m.origin[1] + m.positions[v * 3 + 1] as f64,
                m.origin[2] + m.positions[v * 3 + 2] as f64,
            ]
        })
        .collect()
}

/// Apply a row-major mat4 to a homogeneous point (perspective divided).
fn apply(t: &[f32; 16], p: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = (p[0], p[1], p[2]);
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    [wx / ww, wy / ww, wz / ww]
}

fn max_vertex_error(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    assert_eq!(a.len(), b.len(), "vertex count mismatch ({} vs {})", a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(p, q)| {
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        })
        .fold(0.0f64, f64::max)
}

fn assert_instanced_matches_flat(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    // The don't-bake path must actually fire, or this proves nothing.
    assert!(
        !inst.instances.is_empty(),
        "{label}: instancing produced no InstanceRecords — the don't-bake path did not fire \
         (sample has no repeated single-solid mapped source?)"
    );

    // Flat occurrence lookup: express_id -> its single class-0 mesh. The eligible
    // don't-bake set is single-solid, so each such occurrence is one mesh flat.
    let mut flat_by_id: FxHashMap<u32, &MeshData> = FxHashMap::default();
    for m in &flat.meshes {
        if m.geometry_class == 0 && !m.positions.is_empty() {
            flat_by_id.entry(m.express_id).or_insert(m);
        }
    }
    // Instanced template lookup: express_id -> template mesh (stays in meshes).
    let mut inst_mesh_by_id: FxHashMap<u32, &MeshData> = FxHashMap::default();
    for m in &inst.meshes {
        if !m.positions.is_empty() {
            inst_mesh_by_id.entry(m.express_id).or_insert(m);
        }
    }

    let tol = 1e-6; // 1 micrometre, in model metres.
    let mut checked_instances = 0usize;

    // (1) Every InstanceRecord recomposes to its flat occurrence's world triangles.
    for rec in &inst.instances {
        let template = inst_mesh_by_id.get(&rec.template_express_id).unwrap_or_else(|| {
            panic!(
                "instance {} references template {} not present in instanced meshes",
                rec.express_id, rec.template_express_id
            )
        });
        let flat_occ = flat_by_id.get(&rec.express_id).unwrap_or_else(|| {
            panic!("instance {} has no flat counterpart mesh", rec.express_id)
        });

        let template_world = world_vertices(template);
        let recomposed: Vec<[f64; 3]> =
            template_world.iter().map(|&p| apply(&rec.transform, p)).collect();
        let flat_world = world_vertices(flat_occ);

        let err = max_vertex_error(&recomposed, &flat_world);
        assert!(
            err < tol,
            "{label}: instance {} (template {}): world-vertex error {err:.3e} m exceeds 1um",
            rec.express_id, rec.template_express_id
        );
        checked_instances += 1;
    }
    assert_eq!(checked_instances, inst.instances.len());

    // (2) Each template occurrence itself is byte-identical flat vs instanced (it
    //     goes through the exact same materialize; only its rep_identity was re-tagged).
    for rec in &inst.instances {
        let tid = rec.template_express_id;
        let inst_t = inst_mesh_by_id[&tid];
        let flat_t = flat_by_id
            .get(&tid)
            .unwrap_or_else(|| panic!("template {tid} missing from flat meshes"));
        let err = max_vertex_error(&world_vertices(inst_t), &world_vertices(flat_t));
        assert!(
            err < tol,
            "{label}: template {tid}: instanced vs flat world-vertex error {err:.3e} m exceeds 1um"
        );
    }

    // (3) No geometry lost: every flat occurrence is represented in the instanced
    //     output either as a retained mesh (template / non-instanced) or an instance.
    let inst_ids: std::collections::HashSet<u32> = inst
        .meshes
        .iter()
        .map(|m| m.express_id)
        .chain(inst.instances.iter().map(|r| r.express_id))
        .collect();
    for m in &flat.meshes {
        if m.geometry_class == 0 && !m.positions.is_empty() {
            assert!(
                inst_ids.contains(&m.express_id),
                "{label}: flat occurrence {} is absent from the instanced output (geometry lost)",
                m.express_id
            );
        }
    }
}

/// The materialize reduction: the instanced run emits FEWER full meshes than the flat
/// run (repeated occurrences become records), while representing the same occurrences.
fn assert_reduction(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    let flat_meshes = flat.meshes.iter().filter(|m| !m.positions.is_empty()).count();
    let inst_meshes = inst.meshes.iter().filter(|m| !m.positions.is_empty()).count();
    let flat_verts: usize = flat.meshes.iter().map(|m| m.positions.len() / 3).sum();
    let inst_verts: usize = inst.meshes.iter().map(|m| m.positions.len() / 3).sum();

    assert!(!inst.instances.is_empty(), "{label}: don't-bake did not fire");
    assert!(
        inst_meshes < flat_meshes,
        "{label}: instanced materialized meshes ({inst_meshes}) not fewer than flat ({flat_meshes})"
    );
    // Every non-template occurrence is one skipped materialize.
    assert_eq!(
        inst_meshes + inst.instances.len(),
        flat_meshes,
        "{label}: templates + instances must equal the flat occurrence count"
    );

    eprintln!(
        "[#1623 P2] {label}: flat = {flat_meshes} meshes / {flat_verts} verts; \
         instanced = {inst_meshes} templates + {} instance records / {inst_verts} materialized verts \
         (materialize reduction: {} meshes, {} verts)",
        inst.instances.len(),
        flat_meshes - inst_meshes,
        flat_verts.saturating_sub(inst_verts),
    );
    // Reference the type so the import stays load-bearing regardless of assertions.
    let _: fn(&InstanceRecord) -> u32 = |r| r.express_id;
}

/// Byte-exact canonical key for one mesh: every geometry-bearing field folded to
/// its raw bits (f32/f64 via `to_bits`), so two keys are equal iff the meshes are
/// byte-identical. Metadata that is out of the geometry contract (instance_meta,
/// local_bounds — all `#[serde(skip)]`, recomputed each load) is excluded.
fn mesh_key(m: &MeshData) -> Vec<u8> {
    let mut k = Vec::new();
    k.extend_from_slice(&m.express_id.to_le_bytes());
    k.extend_from_slice(m.ifc_type.as_bytes());
    k.push(0);
    k.extend_from_slice(&m.geometry_item_id.unwrap_or(u32::MAX).to_le_bytes());
    k.push(m.geometry_class);
    for c in m.color {
        k.extend_from_slice(&c.to_bits().to_le_bytes());
    }
    for o in m.origin {
        k.extend_from_slice(&o.to_bits().to_le_bytes());
    }
    for p in &m.positions {
        k.extend_from_slice(&p.to_bits().to_le_bytes());
    }
    for n in &m.normals {
        k.extend_from_slice(&n.to_bits().to_le_bytes());
    }
    for i in &m.indices {
        k.extend_from_slice(&i.to_le_bytes());
    }
    k
}

/// The full geometry-bearing MeshData stream as an order-independent multiset of
/// byte-exact keys (parallel meshing emits in nondeterministic order, so sort).
fn mesh_stream(meshes: &[MeshData]) -> Vec<Vec<u8>> {
    let mut v: Vec<Vec<u8>> = meshes
        .iter()
        .filter(|m| !m.positions.is_empty())
        .map(mesh_key)
        .collect();
    v.sort();
    v
}

/// Distinct colours (bit-exact) emitted per element id.
fn distinct_colors_by_expr(meshes: &[MeshData]) -> FxHashMap<u32, std::collections::HashSet<[u32; 4]>> {
    let mut out: FxHashMap<u32, std::collections::HashSet<[u32; 4]>> = FxHashMap::default();
    for m in meshes.iter().filter(|m| !m.positions.is_empty()) {
        let bits = [
            m.color[0].to_bits(),
            m.color[1].to_bits(),
            m.color[2].to_bits(),
            m.color[3].to_bits(),
        ];
        out.entry(m.express_id).or_default().insert(bits);
    }
    out
}

/// Fix B — a georeferenced (`site_local`) mapped-instance model must produce output
/// BYTE-IDENTICAL with `enable_instancing` ON vs OFF: the site-local guard routes the
/// whole model to the flat path (zero `InstanceRecord`s, identical flat MeshData
/// stream). This proves no perf-regression re-bake AND no misplacement on a
/// translated/rotated site — the don't-bake path (which drops the template's
/// `instance_meta` in the site frame) never arms there. The eligibility is real: the
/// same repeated single-solid source instances at the origin tier (see the synthetic
/// test), so ONLY the coordinate tier keeps it flat.
fn assert_georef_routes_to_flat(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    assert_eq!(
        inst.mesh_coordinate_space.as_deref(),
        Some("site_local"),
        "{label}: expected the site-local coordinate tier (the georef path under test)"
    );
    // The don't-bake plan must NOT have armed: no InstanceRecords on a site-local model.
    assert!(
        inst.instances.is_empty(),
        "{label}: site-local model produced {} InstanceRecords — the guard did not route to flat",
        inst.instances.len()
    );
    // Genuine multi-occurrence single-solid source (would instance at the origin tier):
    // at least two occurrences, all sharing one geometry (identical vertex counts).
    let occ = flat.meshes.iter().filter(|m| !m.positions.is_empty()).count();
    assert!(
        occ >= 2,
        "{label}: expected a repeated mapped source (>=2 occurrences), got {occ}"
    );
    // The hard gate: instanced-ON output is byte-identical to instanced-OFF output.
    assert_eq!(
        mesh_stream(&flat.meshes),
        mesh_stream(&inst.meshes),
        "{label}: site-local instanced-ON MeshData stream differs from instanced-OFF (byte-identity broken)"
    );
    eprintln!("[#1623 P2 georef] {label}: site_local, {occ} occurrences, 0 instance records, ON==OFF byte-identical");
}

/// Fix A (#858) — an indexed-colour mapped source must render the SAME per-triangle
/// palette whether instancing is ON or OFF. The source sits at the origin tier (the
/// plan DOES arm), so the ONLY thing keeping it flat is the indexed-colour guard; an
/// instance placeholder would resolve ONE colour and collapse the palette. Proven by
/// (1) each occurrence carrying >=2 distinct split-group colours, and (2) full
/// byte-identity of the ON vs OFF MeshData stream.
fn assert_indexed_colour_palette_preserved(bytes: &[u8], label: &str) {
    let flat = run(bytes, false);
    let inst = run(bytes, true);

    assert_eq!(
        inst.mesh_coordinate_space.as_deref(),
        Some("raw_ifc"),
        "{label}: expected the origin tier so the don't-bake plan actually arms (only the \
         indexed-colour guard should keep this source flat)"
    );
    // Routed to flat by the palette guard, not instanced.
    assert!(
        inst.instances.is_empty(),
        "{label}: indexed-colour source produced {} InstanceRecords — the palette guard did not fire",
        inst.instances.len()
    );

    // The split fired: EVERY occurrence has >=2 distinct palette-group colours in BOTH
    // runs (the buggy don't-bake collapsed non-template occurrences to one colour).
    for (run_label, res) in [("flat", &flat), ("instanced", &inst)] {
        for (expr, colors) in distinct_colors_by_expr(&res.meshes) {
            assert!(
                colors.len() >= 2,
                "{label} ({run_label}): occurrence {expr} has {} distinct colour(s); the #858 \
                 palette split must yield >=2 (palette collapsed?)",
                colors.len()
            );
        }
    }

    // The hard gate: instanced-ON palette output is byte-identical to instanced-OFF.
    assert_eq!(
        mesh_stream(&flat.meshes),
        mesh_stream(&inst.meshes),
        "{label}: indexed-colour instanced-ON MeshData stream differs from instanced-OFF \
         (palette not preserved bit-for-bit)"
    );
    eprintln!(
        "[#858 indexed-colour] {label}: {} occurrence meshes, per-triangle palette preserved, ON==OFF byte-identical",
        inst.meshes.iter().filter(|m| !m.positions.is_empty()).count()
    );
}

#[test]
fn georef_translated_site_routes_to_flat_byte_identical() {
    assert_georef_routes_to_flat(
        &fixture_bytes("mapped_instances_site_translated.ifc"),
        "site-translated",
    );
}

#[test]
fn georef_rotated_site_routes_to_flat_byte_identical() {
    assert_georef_routes_to_flat(
        &fixture_bytes("mapped_instances_site_rotated.ifc"),
        "site-rotated",
    );
}

#[test]
fn indexed_colour_source_palette_survives_instancing() {
    assert_indexed_colour_palette_preserved(
        &fixture_bytes("mapped_instances_indexed_colour.ifc"),
        "indexed-colour",
    );
}

/// #1807 — a UNIFORM (single-colour) IfcIndexedColourMap must NOT block don't-bake.
/// The #858 palette guard was over-broad: it excluded EVERY indexed-colour source, but
/// `split_mesh_by_indexed_colour` only splits when >=2 palette entries are actually
/// used (`style/indexed_colour.rs`), so a uniform source never splits and loses nothing
/// by instancing — its `dominant()` colour is a single value an instance carries fine.
/// This is the counterpart to `indexed_colour_source_palette_survives_instancing`
/// (multi-colour → stays flat): here the source at the origin tier must now INSTANCE,
/// recompose to the flat world triangles bit-for-bit, and keep its one dominant colour.
fn assert_uniform_indexed_colour_instances(bytes: &[u8], label: &str, expected: [f32; 4]) {
    // Correctness gate: it instances (don't-bake fires) and recomposes to the flat
    // world triangles within 1um — the same hard gate the hello-wall/synthetic use.
    assert_instanced_matches_flat(bytes, label);

    let flat = run(bytes, false);
    let inst = run(bytes, true);
    assert_eq!(
        inst.mesh_coordinate_space.as_deref(),
        Some("raw_ifc"),
        "{label}: expected the origin tier so the don't-bake plan arms (only the \
         indexed-colour guard could keep this source flat)"
    );

    let expected_bits = [
        expected[0].to_bits(),
        expected[1].to_bits(),
        expected[2].to_bits(),
        expected[3].to_bits(),
    ];
    // Uniform ⇒ every retained occurrence mesh carries exactly the one dominant colour
    // in BOTH runs (no palette split; the instanced template inherits the flat colour).
    for (run_label, res) in [("flat", &flat), ("instanced", &inst)] {
        for (expr, colors) in distinct_colors_by_expr(&res.meshes) {
            assert_eq!(
                colors.len(),
                1,
                "{label} ({run_label}): occurrence {expr} has {} distinct colour(s); a uniform \
                 indexed-colour source must stay single-colour",
                colors.len()
            );
            assert!(
                colors.contains(&expected_bits),
                "{label} ({run_label}): occurrence {expr} colour != dominant {expected:?}"
            );
        }
    }
    eprintln!(
        "[#1807 uniform indexed-colour] {label}: {} instance record(s), single dominant colour preserved",
        inst.instances.len()
    );
}

#[test]
fn uniform_indexed_colour_source_instances_keeping_dominant_colour() {
    assert_uniform_indexed_colour_instances(
        &fixture_bytes("mapped_instances_indexed_colour_uniform.ifc"),
        "uniform-indexed-colour",
        // The fixture's ColourIndex is IFC 1-based `(1,1,1,1)`: value 1 → the 0-based
        // `triangle_palette` index 0 → IfcColourRgbList entry (1.,0.,0.) = red, the
        // only palette entry referenced (so `has_multiple_colours()` is false).
        [1.0, 0.0, 0.0, 1.0],
    );
}

#[test]
fn instanced_world_triangles_equal_flat_hello_wall() {
    assert_instanced_matches_flat(&sample_bytes(), "hello-wall");
}

#[test]
fn instanced_world_triangles_equal_flat_synthetic() {
    assert_instanced_matches_flat(&synthetic_bytes(), "synthetic-64");
}

#[test]
fn instancing_reduces_materialized_meshes_hello_wall() {
    assert_reduction(&sample_bytes(), "hello-wall");
}

#[test]
fn instancing_reduces_materialized_meshes_synthetic() {
    assert_reduction(&synthetic_bytes(), "synthetic-64");
}
