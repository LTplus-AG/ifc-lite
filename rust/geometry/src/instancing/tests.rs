// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::collate::mat4_to_row_major_f32;
use super::{
    collate_and_encode, collate_instances, decode_instanced, encode_instanced, verify_recomposition,
    Collated, InstanceMeshRef, INSTANCED_MAGIC, INSTANCED_VERSION,
};
use crate::mesh::{InstanceMeta, Mesh};
use nalgebra::Matrix4;

fn mat_rm(m: &Matrix4<f64>) -> [f64; 16] {
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)];
        }
    }
    out
}

/// Bake a canonical mesh through a full world transform `m`.
fn baked(canonical: &[f32], m: &Matrix4<f64>) -> Vec<f32> {
    let mut out = Vec::with_capacity(canonical.len());
    for v in canonical.chunks_exact(3) {
        let w = m * nalgebra::Vector4::new(v[0] as f64, v[1] as f64, v[2] as f64, 1.0);
        out.push((w.x / w.w) as f32);
        out.push((w.y / w.w) as f32);
        out.push((w.z / w.w) as f32);
    }
    out
}

fn mesh_from(positions: Vec<f32>, meta: InstanceMeta) -> Mesh {
    let n = positions.len() / 3;
    let mut m = Mesh::new();
    m.positions = positions;
    m.normals = vec![0.0; n * 3];
    m.indices = (0..n as u32).collect();
    m.instance_meta = Some(meta);
    m
}

// A canonical unit tetra in source coords.
const CANON: [f32; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

#[test]
fn collates_repeated_representation_and_recomposes_within_a_micrometre() {
    use std::f64::consts::FRAC_PI_3;
    // Three occurrences of rep S=42: distinct placements (rotation + translation),
    // captured as `transform` with no mapping (local_transform None).
    let placements = [
        Matrix4::new_translation(&nalgebra::Vector3::new(10.0, 0.0, 0.0)),
        Matrix4::from_euler_angles(0.0, 0.0, FRAC_PI_3)
            * Matrix4::new_translation(&nalgebra::Vector3::new(-5.0, 7.0, 2.0)),
        Matrix4::from_euler_angles(FRAC_PI_3, 0.0, 0.0)
            * Matrix4::new_translation(&nalgebra::Vector3::new(100.0, -50.0, 3.0)),
    ];
    let meshes: Vec<Mesh> = placements
        .iter()
        .map(|m| {
            mesh_from(
                baked(&CANON, m),
                InstanceMeta {
                    transform: mat_rm(m),
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: 42,
                    instanceable: true,
                },
            )
        })
        .collect();

    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    assert_eq!(collated.templates.len(), 1, "one shared template");
    assert_eq!(collated.flat_indices.len(), 0, "nothing left flat");
    let tmpl = &collated.templates[0];
    assert_eq!(tmpl.rep_identity, 42);
    assert_eq!(tmpl.occurrences.len(), 3);
    // Template occurrence maps to identity.
    assert_eq!(tmpl.occurrences[0].mesh_index, 0);
    let id = Matrix4::<f64>::identity();
    for (a, b) in tmpl.occurrences[0]
        .transform
        .iter()
        .zip(mat4_to_row_major_f32(&id).iter())
    {
        assert!((a - b).abs() < 1e-5, "template transform is identity");
    }

    // The compose/inverse/relative math is exact in f64; the only residual is
    // f32 storage of the baked positions (the real pipeline stores f32 too, so
    // instancing adds no error beyond the flat path's). At |coords| <= 100 that
    // floor is ~1e-6; a row/col-major or multiply-order bug would err by the
    // translation magnitude (tens of units), so 1e-4 stays a sharp guard.
    let err = verify_recomposition(&meshes, &collated);
    assert!(err < 1e-4, "recomposition error {err} exceeds the f32 storage floor");
}

#[test]
fn composes_placement_and_mapping_transform() {
    // M = placement · mapping; split across `transform` and `local_transform`.
    let mapping = Matrix4::new_translation(&nalgebra::Vector3::new(0.5, 0.0, 0.0))
        * Matrix4::new_scaling(1.0);
    let placements = [
        Matrix4::new_translation(&nalgebra::Vector3::new(3.0, 0.0, 0.0)),
        Matrix4::from_euler_angles(0.0, std::f64::consts::FRAC_PI_4, 0.0)
            * Matrix4::new_translation(&nalgebra::Vector3::new(20.0, 1.0, -4.0)),
    ];
    let meshes: Vec<Mesh> = placements
        .iter()
        .map(|p| {
            let full = p * mapping;
            mesh_from(
                baked(&CANON, &full),
                InstanceMeta {
                    transform: mat_rm(p),
                    local_transform: Some(mat_rm(&mapping)),
                    canonical_transform: None,
                    rep_identity: 7,
                    instanceable: true,
                },
            )
        })
        .collect();

    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    assert_eq!(collated.templates.len(), 1);
    assert_eq!(collated.templates[0].occurrences.len(), 2);
    let err = verify_recomposition(&meshes, &collated);
    assert!(err < 1e-4, "placement·mapping recomposition error {err}");
}

#[test]
fn rigid_canonical_transform_recomposes() {
    // Rigid tier: two occurrences of one canonical shape, the second rotated
    // (canonical_transform = C_B ≠ identity). collate must reproduce both
    // baked meshes from the shared template.
    let c_b = Matrix4::from_euler_angles(0.3, 0.9, 0.2)
        * Matrix4::new_translation(&nalgebra::Vector3::new(0.4, -0.2, 0.1));
    let m_a = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 0.0, 0.0));
    let m_b = Matrix4::from_euler_angles(0.0, 0.0, 1.2)
        * Matrix4::new_translation(&nalgebra::Vector3::new(-3.0, 8.0, 2.0));
    let meshes = vec![
        mesh_from(
            baked(&CANON, &m_a),
            InstanceMeta {
                transform: mat_rm(&m_a),
                local_transform: None,
                canonical_transform: None, // template
                rep_identity: 99,
                instanceable: true,
            },
        ),
        mesh_from(
            baked(&CANON, &(m_b * c_b)),
            InstanceMeta {
                transform: mat_rm(&m_b),
                local_transform: None,
                canonical_transform: Some(mat_rm(&c_b)),
                rep_identity: 99,
                instanceable: true,
            },
        ),
    ];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    assert_eq!(collated.templates.len(), 1, "one rigid template");
    assert_eq!(collated.templates[0].occurrences.len(), 2);
    let err = verify_recomposition(&meshes, &collated);
    assert!(err < 1e-4, "rigid canonical_transform recompose error {err}");
}

#[test]
fn instanced_wire_format_roundtrips_and_expands_to_flat() {
    // Two occurrences sharing rep 50 (exact tier, bit-identical local) + a
    // singleton rep 60 (flat). entity_id == input mesh index.
    let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
    let m1 = Matrix4::from_euler_angles(0.0, 0.0, 1.1)
        * Matrix4::new_translation(&nalgebra::Vector3::new(-4.0, 6.0, 2.0));
    let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(9.0, 9.0, 9.0));
    let mk = |m: &Matrix4<f64>, rep: u128| {
        mesh_from(
            baked(&CANON, m),
            InstanceMeta {
                transform: mat_rm(m),
                local_transform: None,
                canonical_transform: None,
                rep_identity: rep,
                instanceable: true,
            },
        )
    };
    let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);

    let bytes = encode_instanced(&meshes, &collated, |i| i as u32, |_| [0.25, 0.5, 0.75, 1.0]);
    let dec = decode_instanced(&bytes).expect("decodes");
    // rep50 -> 1 template (2 occ); rep60 singleton -> 1 template (1 occ).
    assert_eq!(dec.templates.len(), 2, "two templates");
    assert_eq!(dec.instances.len(), 3, "every input mesh is an instance");
    // Losslessness: the rep-50 template geometry is mesh 0 verbatim.
    assert_eq!(dec.templates[0].positions, meshes[0].positions);
    assert_eq!(dec.templates[0].indices, meshes[0].indices);
    assert_eq!(dec.instances[0].color, [0.25, 0.5, 0.75, 1.0]);

    // Expand-to-flat: applying each instance transform to its template
    // reproduces the original occurrence's world geometry.
    for inst in &dec.instances {
        let tmpl = &dec.templates[inst.template_index as usize];
        let rel = Matrix4::from_row_slice(&inst.transform.map(|v| v as f64));
        let orig = &meshes[inst.entity_id as usize];
        assert_eq!(tmpl.positions.len(), orig.positions.len());
        let n = tmpl.positions.len() / 3;
        for v in 0..n {
            let w = rel
                * nalgebra::Vector4::new(
                    tmpl.origin[0] + tmpl.positions[v * 3] as f64,
                    tmpl.origin[1] + tmpl.positions[v * 3 + 1] as f64,
                    tmpl.origin[2] + tmpl.positions[v * 3 + 2] as f64,
                    1.0,
                );
            let gx = orig.origin[0] + orig.positions[v * 3] as f64;
            let gy = orig.origin[1] + orig.positions[v * 3 + 1] as f64;
            let gz = orig.origin[2] + orig.positions[v * 3 + 2] as f64;
            let err = ((w.x / w.w - gx).powi(2)
                + (w.y / w.w - gy).powi(2)
                + (w.z / w.w - gz).powi(2))
            .sqrt();
            assert!(err < 1e-4, "expand-to-flat vertex error {err}");
        }
    }
}

/// Dumps a deterministic instanced-shard fixture as hex for the cross-language
/// TS conformance test (packed-instanced-decoder.test.ts). Run on demand:
/// `cargo test -p ifc-lite-geometry --lib dump_instanced_fixture -- --ignored --nocapture`
/// then paste the hex into the TS fixture. Pure-translation transforms keep
/// the expected world geometry trivially checkable on both sides.
#[test]
#[ignore]
fn dump_instanced_fixture() {
    let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
    let m1 = Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 2.0, 0.0));
    let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 5.0, 5.0));
    let mk = |m: &Matrix4<f64>, rep: u128| {
        mesh_from(
            baked(&CANON, m),
            InstanceMeta {
                transform: mat_rm(m),
                local_transform: None,
                canonical_transform: None,
                rep_identity: rep,
                instanceable: true,
            },
        )
    };
    let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    let bytes = encode_instanced(&meshes, &collated, |i| (1000 + i) as u32, |i| {
        [i as f32 * 0.1, 0.2, 0.3, 1.0]
    });
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    println!("INSTANCED_FIXTURE_HEX_BEGIN");
    println!("{hex}");
    println!("INSTANCED_FIXTURE_HEX_END");
}

#[test]
fn collate_count_guard_drops_mismatched_group_to_flat() {
    // A rep_identity grouping with mismatched vertex/index counts (e.g. a
    // hash collision that survived the count differing) must NOT instance —
    // the cheap count guard falls the whole group to flat. (Same-count content
    // collisions are prevented upstream by the 128-bit rep_identity hash.)
    let p = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
    let meta = |rep| InstanceMeta {
        transform: mat_rm(&p),
        local_transform: None,
        canonical_transform: None,
        rep_identity: rep,
        instanceable: true,
    };
    // canon_b has 5 vertices vs CANON's 4 → different counts.
    let canon_b: [f32; 15] = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 2.0, 2.0,
    ];
    let meshes = vec![
        mesh_from(baked(&CANON, &p), meta(777)),
        mesh_from(baked(&canon_b, &p), meta(777)), // same rep, different counts
    ];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    assert_eq!(collated.templates.len(), 0, "count mismatch must NOT form a template");
    assert_eq!(collated.flat_indices.len(), 2, "both fall to flat");
}

#[test]
fn collate_reduces_georeferenced_rotated_occurrence_to_post_rtc_frame() {
    // Regression for the GLB-export collapse: a rotated occurrence at a
    // georeferenced placement. Computing `rel = m_k · m_ref⁻¹` on the raw
    // pre-RTC (absolute, ~1e6 m) transforms makes the relative translation reach
    // `T_k − R_rel·T_ref ≈ 2× rtc` when the rotation flips the sign — the
    // occurrence then lands at twice the georeference and collapses the f32 GLB.
    // Passing the applied rtc reduces both transforms to the post-RTC frame so
    // `rel` stays building-scale (consistent with the small baked origin).
    let rtc = [1_000_000.0_f64, 2_000_000.0, 0.0];
    let t_template = Matrix4::new_translation(&nalgebra::Vector3::new(rtc[0], rtc[1], rtc[2]));
    // Same placement, rotated 180° about Z — the worst case (sign flip).
    let t_occ = t_template * Matrix4::from_euler_angles(0.0, 0.0, std::f64::consts::PI);
    let mk = |m: &Matrix4<f64>| {
        mesh_from(
            baked(&CANON, m),
            InstanceMeta {
                transform: mat_rm(m),
                local_transform: None,
                canonical_transform: None,
                rep_identity: 99,
                instanceable: true,
            },
        )
    };
    let meshes = vec![mk(&t_template), mk(&t_occ)];
    // occurrence transform translation magnitude (row-major mat4 → [3],[7],[11]).
    let occ_trans = |c: &Collated| -> f64 {
        let occ = &c.templates[0].occurrences;
        occ.iter()
            .map(|o| o.transform[3].abs().max(o.transform[7].abs()).max(o.transform[11].abs()) as f64)
            .fold(0.0, f64::max)
    };

    // Without the rtc reduction (legacy behaviour) the rotated occurrence blows
    // up to ~2× the georef offset.
    let raw = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    assert_eq!(raw.templates.len(), 1, "the two congruent meshes instance");
    assert!(occ_trans(&raw) > 1_000_000.0, "legacy: rotated occurrence reaches ~2× rtc");

    // With the applied rtc the relative transform stays building-scale.
    let fixed = collate_instances(&meshes, 2, rtc);
    assert_eq!(fixed.templates.len(), 1, "still instances after the reduction");
    assert!(occ_trans(&fixed) < 10.0, "fixed: rel translation is building-scale, got {}", occ_trans(&fixed));
}

#[test]
fn collate_and_encode_matches_mesh_path() {
    // The zero-copy ref one-shot must produce byte-identical output to the
    // Mesh-based collate + encode (the engine emit uses the ref path).
    let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
    let m1 = Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 2.0, 0.0));
    let m2 = Matrix4::new_translation(&nalgebra::Vector3::new(5.0, 5.0, 5.0));
    let mk = |m: &Matrix4<f64>, rep: u128| {
        mesh_from(
            baked(&CANON, m),
            InstanceMeta {
                transform: mat_rm(m),
                local_transform: None,
                canonical_transform: None,
                rep_identity: rep,
                instanceable: true,
            },
        )
    };
    let meshes = vec![mk(&m0, 50), mk(&m1, 50), mk(&m2, 60)];
    let col = |i: usize| [i as f32 * 0.1, 0.2, 0.3, 1.0];

    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    let bytes_mesh = encode_instanced(&meshes, &collated, |i| i as u32, col);

    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let mut r = InstanceMeshRef::from_mesh(m);
            r.entity_id = i as u32;
            r.color = col(i);
            r
        })
        .collect();
    let bytes_ref = collate_and_encode(&refs, 2, [0.0, 0.0, 0.0]);

    assert_eq!(bytes_mesh, bytes_ref, "ref one-shot must match the Mesh path byte-for-byte");
    // And it must still decode + expand.
    let dec = decode_instanced(&bytes_ref).expect("decodes");
    assert_eq!(dec.templates.len(), 2);
    assert_eq!(dec.instances.len(), 3);
}

#[test]
fn dont_bake_empty_occurrence_refs_recompose_like_materialized() {
    // #1623 Phase 3: the browser don't-bake path feeds `collate_refs` a single
    // MATERIALIZED template plus EMPTY-geometry occurrence placeholders (each
    // carrying only the pre-RTC world transform, id, and colour). The resulting
    // shard must recompose to the EXACT same world triangles as if every
    // occurrence had been materialized flat — the byte-identity gate.
    use std::f64::consts::FRAC_PI_4;
    let placements = [
        Matrix4::new_translation(&nalgebra::Vector3::new(2.0, 0.0, 0.0)),
        Matrix4::from_euler_angles(0.0, 0.0, FRAC_PI_4)
            * Matrix4::new_translation(&nalgebra::Vector3::new(-6.0, 4.0, 1.0)),
        Matrix4::from_euler_angles(FRAC_PI_4, 0.0, 0.0)
            * Matrix4::new_translation(&nalgebra::Vector3::new(30.0, -12.0, 5.0)),
    ];
    let meta_for = |m: &Matrix4<f64>| InstanceMeta {
        transform: mat_rm(m),
        local_transform: None,
        canonical_transform: None,
        rep_identity: 314,
        instanceable: true,
    };

    // A: the FLAT baseline — every occurrence materialized (baked verts + meta).
    let materialized: Vec<Mesh> = placements
        .iter()
        .map(|m| mesh_from(baked(&CANON, m), meta_for(m)))
        .collect();
    let flat_shard = {
        let refs: Vec<InstanceMeshRef> = materialized
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let mut r = InstanceMeshRef::from_mesh(m);
                r.entity_id = 1000 + i as u32;
                r.color = [0.2, 0.4, 0.6, 1.0];
                r
            })
            .collect();
        collate_and_encode(&refs, 2, [0.0, 0.0, 0.0])
    };

    // B: the don't-bake path — occurrence 0 materialized as the template, 1 & 2 as
    // EMPTY placeholders carrying only their world transform (no baked geometry).
    let template = &materialized[0];
    let metas: Vec<InstanceMeta> = placements[1..].iter().map(meta_for).collect();
    let mut refs_db: Vec<InstanceMeshRef> = Vec::new();
    let mut tmpl_ref = InstanceMeshRef::from_mesh(template);
    tmpl_ref.entity_id = 1000;
    tmpl_ref.color = [0.2, 0.4, 0.6, 1.0];
    refs_db.push(tmpl_ref);
    for (k, meta) in metas.iter().enumerate() {
        refs_db.push(InstanceMeshRef {
            positions: &[],
            normals: &[],
            indices: &[],
            origin: [0.0; 3],
            instance_meta: Some(meta),
            entity_id: 1000 + (k as u32 + 1),
            color: [0.2, 0.4, 0.6, 1.0],
        });
    }
    let db_shard = collate_and_encode(&refs_db, 2, [0.0, 0.0, 0.0]);

    // Both shards must be byte-identical: same one template geometry (occurrence 0),
    // same three instances, same ids/colours/transforms. The don't-bake path never
    // materialized occurrences 1 & 2, yet produces the identical wire shard.
    assert_eq!(
        flat_shard, db_shard,
        "don't-bake empty-occurrence shard must equal the fully-materialized shard byte-for-byte"
    );

    // And it recomposes to the flat baked world verts within a micrometre.
    let dec = decode_instanced(&db_shard).expect("decodes");
    assert_eq!(dec.templates.len(), 1, "one shared template");
    assert_eq!(dec.instances.len(), 3, "template + two don't-bake occurrences");
    for inst in &dec.instances {
        let tmpl = &dec.templates[inst.template_index as usize];
        let rel = Matrix4::from_row_slice(&inst.transform.map(|v| v as f64));
        let orig_idx = (inst.entity_id - 1000) as usize;
        let orig = &materialized[orig_idx];
        let n = tmpl.positions.len() / 3;
        for v in 0..n {
            let w = rel
                * nalgebra::Vector4::new(
                    tmpl.origin[0] + tmpl.positions[v * 3] as f64,
                    tmpl.origin[1] + tmpl.positions[v * 3 + 1] as f64,
                    tmpl.origin[2] + tmpl.positions[v * 3 + 2] as f64,
                    1.0,
                );
            let gx = orig.origin[0] + orig.positions[v * 3] as f64;
            let gy = orig.origin[1] + orig.positions[v * 3 + 1] as f64;
            let gz = orig.origin[2] + orig.positions[v * 3 + 2] as f64;
            let err = ((w.x / w.w - gx).powi(2)
                + (w.y / w.w - gy).powi(2)
                + (w.z / w.w - gz).powi(2))
            .sqrt();
            assert!(err < 1e-4, "don't-bake recompose vertex error {err}");
        }
    }
}

#[test]
fn decode_rejects_bad_magic() {
    assert!(decode_instanced(&[0u8; 32]).is_none());
    assert!(decode_instanced(&[]).is_none());
}

/// Little-endian instanced-shard header (mirrors the packed-instanced-decoder.test.ts
/// header helper): magic, version, template_count, instance_count, positions_len,
/// normals_len, indices_len, reserved.
fn header_bytes(
    magic: u32,
    version: u32,
    template_count: u32,
    instance_count: u32,
    positions_len: u32,
    normals_len: u32,
    indices_len: u32,
) -> Vec<u8> {
    let mut b = Vec::with_capacity(32);
    for v in [
        magic,
        version,
        template_count,
        instance_count,
        positions_len,
        normals_len,
        indices_len,
        0,
    ] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

#[test]
fn decode_rejects_truncated_payload_with_valid_header() {
    // Mirrors the TS conformance test "rejects a truncated buffer": valid
    // magic/version and a header whose counts describe a real shard, but the
    // byte buffer is cut short before the data actually ends.
    let m0 = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 0.0, 0.0));
    let m1 = Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 2.0, 0.0));
    let mk = |m: &Matrix4<f64>, rep: u128| {
        mesh_from(
            baked(&CANON, m),
            InstanceMeta {
                transform: mat_rm(m),
                local_transform: None,
                canonical_transform: None,
                rep_identity: rep,
                instanceable: true,
            },
        )
    };
    let meshes = vec![mk(&m0, 50), mk(&m1, 50)];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    let bytes = encode_instanced(&meshes, &collated, |i| i as u32, |_| [1.0, 1.0, 1.0, 1.0]);
    assert!(decode_instanced(&bytes).is_some(), "sanity: full buffer decodes");

    // Chop off the last byte of the data pool: the header/tables still claim
    // the original counts, but the trailing index read now runs off the end
    // of the slice.
    let truncated = &bytes[..bytes.len() - 1];
    assert!(
        decode_instanced(truncated).is_none(),
        "truncated payload (valid magic/version, short data) must decode to None, not panic"
    );

    // Chopping mid-table (well before any data) must also fail gracefully.
    let mid_table = &bytes[..40];
    assert!(
        decode_instanced(mid_table).is_none(),
        "buffer truncated inside the template table must decode to None"
    );
}

#[test]
fn decode_rejects_bogus_huge_counts_without_oom() {
    // A corrupt/hostile header can claim an arbitrary template_count or
    // instance_count. Before wire.rs's buffer-length guard, `decode_instanced`
    // sized `Vec::with_capacity(template_count)` / `Vec::with_capacity(instance_count)`
    // directly off these untrusted header fields (wire.rs ~231/253) — a bogus
    // huge count would try to reserve hundreds of GB and abort the process via
    // the allocator's OOM handler, well before the per-field truncation checks
    // ever got a chance to return `None`. The buffer here is only 32 bytes (a
    // bare header), so any allocation sized off these counts would be
    // wildly disproportionate to the data actually available.
    let huge = u32::MAX;

    // Huge template_count, no instances.
    let bytes = header_bytes(INSTANCED_MAGIC, INSTANCED_VERSION, huge, 0, 0, 0, 0);
    assert_eq!(bytes.len(), 32);
    assert!(
        decode_instanced(&bytes).is_none(),
        "bogus huge template_count must decode to None, not attempt a huge allocation"
    );

    // Huge instance_count, no templates.
    let bytes = header_bytes(INSTANCED_MAGIC, INSTANCED_VERSION, 0, huge, 0, 0, 0);
    assert!(
        decode_instanced(&bytes).is_none(),
        "bogus huge instance_count must decode to None, not attempt a huge allocation"
    );

    // Both huge at once.
    let bytes = header_bytes(INSTANCED_MAGIC, INSTANCED_VERSION, huge, huge, huge, huge, huge);
    assert!(
        decode_instanced(&bytes).is_none(),
        "bogus huge counts across the board must decode to None, not attempt a huge allocation"
    );
}

#[test]
fn singletons_and_non_instanceable_go_flat() {
    let p = Matrix4::new_translation(&nalgebra::Vector3::new(1.0, 2.0, 3.0));
    let meta = |rep, inst| InstanceMeta {
        transform: mat_rm(&p),
        local_transform: None,
                    canonical_transform: None,
        rep_identity: rep,
        instanceable: inst,
    };
    let meshes = vec![
        mesh_from(baked(&CANON, &p), meta(1, true)), // singleton rep 1
        mesh_from(baked(&CANON, &p), meta(2, false)), // not instanceable
    ];
    let collated = collate_instances(&meshes, 2, [0.0, 0.0, 0.0]);
    // BOTH meshes must be represented. The instanceable singleton has no repeat
    // so it goes flat; the non-instanceable mesh must STILL be drawn (emitted as
    // a flat singleton), not dropped — dropping it silently loses geometry on
    // real models (void-cut walls / multi-item merges carry instance: None).
    assert_eq!(collated.templates.len(), 0);
    let mut flat = collated.flat_indices.clone();
    flat.sort_unstable();
    assert_eq!(flat, vec![0, 1], "singleton + non-instanceable both emitted flat");
    assert_eq!(collated.unique_geometry_count(), 2);
}
