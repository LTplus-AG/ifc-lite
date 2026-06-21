// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Real-pipeline validation of always-on instancing capture + the collate/IFNS
//! producer.
//!
//! The unit tests in `geometry::instancing` use hand-built meshes that are all
//! instanceable, which hid a class of bug: on REAL models the pipeline emits
//! void-cut walls / multi-item merges with `instance: None`, and an earlier
//! `collate_refs` silently dropped those. Now that capture is always-on (no flag)
//! and the renderer consumer will feed the collator real geometry, this test runs
//! the ACTUAL geometry pipeline on real IFC and proves the collated IFNS shard
//! (a) loses no geometry, (b) neither drops nor duplicates vertices, and
//! (c) round-trips world positions through the wire format + transforms.

use ifc_lite_geometry::{collate_and_encode, decode_instanced, InstanceMeshRef};
use ifc_lite_processing::{process_geometry, MeshData};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read fixture {path}: {e}"))
}

/// Apply a row-major mat4 to a homogeneous point, returning the perspective-divided xyz.
fn apply_row_major(t: &[f32; 16], x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let wx = t[0] as f64 * x + t[1] as f64 * y + t[2] as f64 * z + t[3] as f64;
    let wy = t[4] as f64 * x + t[5] as f64 * y + t[6] as f64 * z + t[7] as f64;
    let wz = t[8] as f64 * x + t[9] as f64 * y + t[10] as f64 * z + t[11] as f64;
    let ww = t[12] as f64 * x + t[13] as f64 * y + t[14] as f64 * z + t[15] as f64;
    (wx / ww, wy / ww, wz / ww)
}

fn assert_roundtrip(name: &str) {
    let bytes = fixture(name);
    let result = process_geometry(bytes.as_slice());
    let non_empty: Vec<&MeshData> = result
        .meshes
        .iter()
        .filter(|m| !m.positions.is_empty())
        .collect();
    assert!(
        !non_empty.is_empty(),
        "{name}: pipeline produced no non-empty meshes"
    );

    let refs: Vec<InstanceMeshRef> = non_empty
        .iter()
        .map(|m| InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
        })
        .collect();

    // min_group = 2: any repeat instances; singletons + non-instanceable stay flat.
    let shard = collate_and_encode(&refs, 2);
    let decoded = decode_instanced(&shard).expect("decode IFNS shard");

    // (a) NO geometry lost — exactly one occurrence per non-empty input mesh.
    //     Before the collate fix, `instance: None` meshes (void-cut CSG here) were
    //     dropped entirely, so this would read 0 occurrences.
    assert_eq!(
        decoded.instances.len(),
        non_empty.len(),
        "{name}: occurrence count != non-empty mesh count — collate dropped geometry"
    );

    // (b) Total expanded vertices == total input vertices (no loss, no duplication).
    //     Each input mesh maps to exactly one occurrence of its template; an
    //     instanced group of N still expands to N×(template verts) == N inputs.
    let in_verts: usize = non_empty.iter().map(|m| m.positions.len()).sum();
    let out_verts: usize = decoded
        .instances
        .iter()
        .map(|i| decoded.templates[i.template_index as usize].positions.len())
        .sum();
    assert_eq!(in_verts, out_verts, "{name}: expanded vertex count mismatch");

    // (c) World bbox preserved through wire format + transforms. Reconstruct each
    //     occurrence as transform · (template.origin + template.position).
    let mut in_lo = [f64::INFINITY; 3];
    let mut in_hi = [f64::NEG_INFINITY; 3];
    for m in &non_empty {
        for v in m.positions.chunks_exact(3) {
            for a in 0..3 {
                let w = m.origin[a] + v[a] as f64;
                in_lo[a] = in_lo[a].min(w);
                in_hi[a] = in_hi[a].max(w);
            }
        }
    }
    let mut out_lo = [f64::INFINITY; 3];
    let mut out_hi = [f64::NEG_INFINITY; 3];
    for inst in &decoded.instances {
        let tmpl = &decoded.templates[inst.template_index as usize];
        for v in tmpl.positions.chunks_exact(3) {
            let (wx, wy, wz) = apply_row_major(
                &inst.transform,
                tmpl.origin[0] + v[0] as f64,
                tmpl.origin[1] + v[1] as f64,
                tmpl.origin[2] + v[2] as f64,
            );
            out_lo[0] = out_lo[0].min(wx);
            out_hi[0] = out_hi[0].max(wx);
            out_lo[1] = out_lo[1].min(wy);
            out_hi[1] = out_hi[1].max(wy);
            out_lo[2] = out_lo[2].min(wz);
            out_hi[2] = out_hi[2].max(wz);
        }
    }
    for a in 0..3 {
        assert!(
            (in_lo[a] - out_lo[a]).abs() < 1e-3 && (in_hi[a] - out_hi[a]).abs() < 1e-3,
            "{name}: world bbox axis {a} drifted: in [{:.4},{:.4}] out [{:.4},{:.4}]",
            in_lo[a],
            in_hi[a],
            out_lo[a],
            out_hi[a]
        );
    }
}

#[test]
fn bath_csg_solid_roundtrips() {
    assert_roundtrip("bath_csg_solid.ifc");
}

#[test]
fn halfspace_flyaway_roundtrips() {
    assert_roundtrip("issue_1155_halfspace_flyaway.ifc");
}

#[test]
fn swept_disk_trimmed_line_roundtrips() {
    assert_roundtrip("swept_disk_trimmed_line.ifc");
}
