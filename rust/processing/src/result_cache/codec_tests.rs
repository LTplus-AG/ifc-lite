// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Codec round trip over a result that sets every field, fingerprint
//! completeness, and hostile entries: truncation, flipped bytes, overflowing
//! counts, overlapping sections, wrong identity, and a seeded fuzz loop whose
//! mutations are re-sealed so they get past the checksums.

use super::envelope::{decode_entry, encode_entry, validate_entry, EntryIdentity, BODY_START, HEADER_LEN};
use super::CodecError;
use crate::types::mesh::{InstanceRecord, MeshData, MeshTextureData};
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, TextureBinding, UvAuthority,
};
use crate::types::response::{ModelMetadata, ProcessingStats};
use crate::{result_fingerprint, Georeferencing, MeshCoordinateSpace, MeshFrame, ProcessingResult};
use ifc_lite_geometry::{GeometryDiagnostics, HostBbox, InstanceMeta, ReasonCount, WorstHost};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) fn identity() -> EntryIdentity {
    EntryIdentity { key: [1; 32], source_sha256: [2; 32], source_len: 3, request_digest: [4; 32], engine_digest: [5; 32] }
}

fn mesh(id: u32) -> MeshData {
    MeshData::new(id, "IfcWall".into(), vec![0.0, -0.0, 1.5, 2.0, 3.0, f32::from_bits(0x7fc0_0001)], vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0], vec![0, 1, 1], [0.1, 0.2, 0.3, 1.0])
}

/// A result with every optional field set somewhere, shared texture pixels,
/// signed zeros and a NaN payload.
pub(super) fn full_result() -> ProcessingResult {
    let pixels = Arc::new(vec![1u8, 2, 3, 4, 5, 6, 7, 8]);
    let mut a = mesh(10)
        .with_element_metadata(Some("gid".into()), Some("name".into()), Some("layer".into()))
        .with_style_metadata(Some("brick".into()), Some(77), false)
        .with_properties(Some([("A".into(), "1".into()), ("B".into(), String::new())].into()))
        .with_geometry_class(3)
        .with_origin([1e6, -0.0, 2.5])
        .with_local_bounds(Some([0.0, 1.0, 2.0, 3.0, 4.0, 5.0]))
        .with_local_to_world(Some([0.5; 16]))
        .with_instance(Some(InstanceMeta {
            transform: [2.0; 16],
            local_transform: Some([3.0; 16]),
            canonical_transform: None,
            rep_identity: u128::MAX - 7,
            instanceable: true,
        }));
    a.uvs = Some(vec![0.0, 1.0, 0.5, 0.5]);
    a.texture = Some(MeshTextureData { texture_id: 9, rgba: Some(pixels.clone()), width: 1, height: 2, url: None, repeat_s: true, repeat_t: false });
    a.presentation = Some(Box::new(MeshPresentationProvenance {
        normals: NormalProvenance::RecomputedAfterWindingRepair,
        palette: Some(PaletteBinding::Bound { map_id: 1, face_set_id: 2, palette_index: 3 }),
        texture: Some(TextureBinding { texture_id: 9, face_set_id: Some(4), uv_authority: UvAuthority::Fabricated }),
    }));
    let mut b = mesh(11).with_style_metadata(None, Some(88), true);
    b.texture = Some(MeshTextureData { texture_id: 9, rgba: Some(pixels), width: 1, height: 2, url: None, repeat_s: false, repeat_t: true });
    b.presentation = Some(Box::new(MeshPresentationProvenance {
        normals: NormalProvenance::RecomputedMissing,
        palette: Some(PaletteBinding::Absent { map_id: 5, reason: PaletteAbsence::SupersededByTexture }),
        texture: None,
    }));
    let mut c = mesh(12);
    c.texture = Some(MeshTextureData { texture_id: 4, rgba: None, width: 0, height: 0, url: Some("img.png".into()), repeat_s: true, repeat_t: true });
    let mut stats = ProcessingStats {
        total_meshes: 3,
        total_vertices: 6,
        parse_time_ms: 12,
        total_time_ms: 34,
        total_csg_failures: 2,
        refused_input_elements: 1,
        point_cache_hits: 99,
        ..Default::default()
    };
    stats.geometry_diagnostics = Some(GeometryDiagnostics {
        total_csg_failures: 2,
        failures_by_reason: vec![ReasonCount { reason: "KernelError".into(), count: 2 }],
        worst_hosts: vec![WorstHost {
            product_id: 10,
            ifc_type: "IfcWall".into(),
            openings: 3,
            csg_failures: 2,
            first_failure_label: Some("KernelError".into()),
            bbox: Some(HostBbox { min: [-0.0, 1.0, 2.0], max: [3.0, 4.0, 5.0] }),
            triangle_count: Some(12),
        }],
        unsupported_items_by_type: vec![ReasonCount { reason: "IfcFoo".into(), count: 1 }],
        ..Default::default()
    });
    let metadata = ModelMetadata {
        schema_version: "IFC4".into(),
        entity_count: 1234,
        geometry_entity_count: 3,
        length_unit_scale: Some(0.001),
        length_unit_refused: Some(7),
        georeferencing: Some(Georeferencing { crs_name: Some("EPSG:2056".into()), eastings: 2.6e6, transform_matrix: [1.0; 16], map_unit_scale: Some(1.0), ..Default::default() }),
        ..Default::default()
    };
    ProcessingResult {
        meshes: vec![a, b, c],
        instances: vec![InstanceRecord {
            express_id: 20,
            ifc_type: "IfcFlowFitting".into(),
            global_id: Some("g20".into()),
            name: None,
            presentation_layer: Some("L".into()),
            color: [1.0, 0.0, -0.0, 0.5],
            template_express_id: 10,
            rep_identity: 42,
            transform: [0.25; 16],
            geometry_item_id: Some(5),
        }],
        mesh_coordinate_space: MeshCoordinateSpace::SiteLocal,
        frame: MeshFrame::SiteLocal { placement: [0.75; 16] },
        site_transform: Some(vec![1.0; 16]),
        building_transform: None,
        metadata,
        stats,
    }
}

pub(super) fn decode(bytes: &[u8]) -> Result<ProcessingResult, CodecError> {
    let layout = validate_entry(bytes, &identity())?;
    decode_entry(bytes, &layout)
}

#[test]
fn round_trip_preserves_every_field_bits_and_texture_sharing() {
    let original = full_result();
    let bytes = encode_entry(&original, &identity()).expect("encodes");
    let replay = decode(&bytes).expect("decodes");
    assert_eq!(result_fingerprint(&replay, true), result_fingerprint(&original, true));
    let shared = |r: &ProcessingResult, i: usize| r.meshes[i].texture.as_ref().unwrap().rgba.clone().unwrap();
    assert!(Arc::ptr_eq(&shared(&replay, 0), &shared(&replay, 1)), "one allocation, as in the producer");
    assert_eq!(replay.meshes[0].positions[1].to_bits(), (-0.0f32).to_bits());
    assert_eq!(replay.meshes[0].positions[5].to_bits(), 0x7fc0_0001);
    // Encoding is deterministic.
    assert_eq!(bytes, encode_entry(&replay, &identity()).unwrap());
}

/// The fingerprint is the acceptance oracle, so it must see every field: each
/// single-field change below must move it. A codec that dropped any of these
/// would fail the round trip above.
#[test]
fn fingerprint_sees_every_field() {
    type Mutation = fn(&mut ProcessingResult);
    let mutations: &[(&str, Mutation)] = &[
        ("uv", |r| r.meshes[0].uvs.as_mut().unwrap()[0] = 0.25),
        ("texture bytes", |r| r.meshes[0].texture.as_mut().unwrap().rgba = Some(Arc::new(vec![9; 8]))),
        ("texture sharing", |r| {
            let t = r.meshes[1].texture.as_mut().unwrap();
            t.rgba = Some(Arc::new(t.rgba.as_ref().unwrap().as_ref().clone()));
        }),
        ("texture url", |r| r.meshes[2].texture.as_mut().unwrap().url = Some("other.png".into())),
        ("material name", |r| r.meshes[0].material_name = None),
        ("properties", |r| r.meshes[0].properties = Some(Default::default())),
        ("name", |r| r.meshes[0].name = Some("other".into())),
        ("instance meta", |r| r.meshes[0].instance.as_mut().unwrap().instanceable = false),
        ("canonical transform", |r| r.meshes[0].instance.as_mut().unwrap().canonical_transform = Some([0.0; 16])),
        ("local bounds", |r| r.meshes[0].local_bounds = None),
        ("local to world", |r| r.meshes[0].local_to_world.as_mut().unwrap()[3] = -0.5),
        ("presentation", |r| r.meshes[1].presentation = None),
        ("uv authority", |r| r.meshes[0].presentation.as_mut().unwrap().texture.as_mut().unwrap().uv_authority = UvAuthority::Dropped),
        ("signed zero", |r| r.meshes[0].positions[1] = 0.0),
        ("nan payload", |r| r.meshes[0].positions[5] = f32::NAN),
        ("origin", |r| r.meshes[0].origin[1] = 0.0),
        ("instances", |r| r.instances[0].transform[0] = 1.0),
        ("frame", |r| r.frame = MeshFrame::SiteLocal { placement: [0.5; 16] }),
        ("building transform", |r| r.building_transform = Some(vec![])),
        ("georef", |r| r.metadata.georeferencing.as_mut().unwrap().map_zone = Some("32N".into())),
        ("unit refusal", |r| r.metadata.length_unit_refused = None),
        ("refused input", |r| r.stats.refused_input_elements = 0),
        ("diagnostics", |r| r.stats.geometry_diagnostics.as_mut().unwrap().worst_hosts[0].bbox = None),
        ("point cache", |r| r.stats.point_cache_hits = 0),
    ];
    let base = result_fingerprint(&full_result(), false);
    for (name, mutate) in mutations {
        let mut changed = full_result();
        mutate(&mut changed);
        assert_ne!(result_fingerprint(&changed, false), base, "fingerprint ignores {name}");
    }
    let mut timing = full_result();
    timing.stats.total_time_ms += 1;
    assert_eq!(result_fingerprint(&timing, false), base, "timings excluded unless asked");
    assert_ne!(result_fingerprint(&timing, true), result_fingerprint(&full_result(), true));
}

/// Split an entry into its section payloads and counts.
pub(super) fn sections(bytes: &[u8]) -> Vec<(Vec<u8>, u64)> {
    (0..4)
        .map(|i| {
            let e = HEADER_LEN + i * 64;
            let at = |o: usize| u64::from_le_bytes(bytes[e + o..e + o + 8].try_into().unwrap()) as usize;
            (bytes[at(8)..at(8) + at(16)].to_vec(), at(24) as u64)
        })
        .collect()
}

/// Re-assemble an entry from (possibly forged) payloads with correct offsets
/// and checksums: what a same-user forger could write.
pub(super) fn seal(template: &[u8], parts: &[(Vec<u8>, u64)]) -> Vec<u8> {
    let mut out = template[..BODY_START].to_vec();
    let mut offset = BODY_START as u64;
    for (i, (payload, count)) in parts.iter().enumerate() {
        let e = HEADER_LEN + i * 64;
        out[e + 8..e + 16].copy_from_slice(&offset.to_le_bytes());
        out[e + 16..e + 24].copy_from_slice(&(payload.len() as u64).to_le_bytes());
        out[e + 24..e + 32].copy_from_slice(&count.to_le_bytes());
        out[e + 32..e + 64].copy_from_slice(&Sha256::digest(payload));
        offset += payload.len() as u64;
    }
    parts.iter().for_each(|(p, _)| out.extend_from_slice(p));
    let total = out.len() as u64;
    out[24..32].copy_from_slice(&total.to_le_bytes());
    reseal_directory(&mut out);
    out
}

pub(super) fn reseal_directory(out: &mut [u8]) {
    let digest = Sha256::new().chain_update(&out[..168]).chain_update(&out[HEADER_LEN..BODY_START]).finalize();
    out[168..HEADER_LEN].copy_from_slice(&digest);
}

#[test]
fn seal_reproduces_the_encoder() {
    let bytes = encode_entry(&full_result(), &identity()).unwrap();
    assert_eq!(seal(&bytes, &sections(&bytes)), bytes);
}

#[path = "hostile_tests.rs"]
mod hostile_tests;
