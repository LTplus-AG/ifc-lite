// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A complete, ordered fingerprint of a [`ProcessingResult`]: every field,
//! including the `#[serde(skip)]` in-memory ones (`instance`, `local_bounds`,
//! `local_to_world`, `presentation`), text metadata, UVs, texture bytes and
//! which meshes share one texture allocation, instances, the frame, transforms,
//! metadata and diagnostics. Floats feed their exact IEEE bits, so `-0.0` and
//! NaN payloads count. Every struct is destructured in full, so a new field is
//! a compile error here until it is classified.
//!
//! It exists to check the result cache's replay, so it is written separately
//! from the cache codec and never calls it: a field the codec drops still
//! changes this digest. `perf_probe --result-fingerprint` prints it.
//!
//! Two kinds of field are left out, stated rather than hidden:
//! [`ProcessingStats::from_cache`] (a replay sets it; that is its job) and,
//! unless `include_timings`, the wall-clock `*_time_ms` fields, which differ
//! between any two cold runs.

use crate::types::mesh::{InstanceRecord, MeshData, MeshTextureData};
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, TextureBinding, UvAuthority,
};
use crate::types::response::{CoordinateInfo, ModelMetadata, ProcessingStats};
use crate::{Georeferencing, MeshFrame, ProcessingResult};
use ifc_lite_geometry::{GeometryDiagnostics, InstanceMeta};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

struct Fp(Sha256);

impl Fp {
    fn raw(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    fn len(&mut self, n: usize) {
        self.raw(&(n as u64).to_le_bytes());
    }
    fn u8(&mut self, v: u8) {
        self.raw(&[v]);
    }
    fn bool(&mut self, v: bool) {
        self.u8(u8::from(v));
    }
    fn u32(&mut self, v: u32) {
        self.raw(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.raw(&v.to_le_bytes());
    }
    fn f32s(&mut self, v: &[f32]) {
        self.len(v.len());
        v.iter().for_each(|x| self.raw(&x.to_bits().to_le_bytes()));
    }
    fn f64s(&mut self, v: &[f64]) {
        self.len(v.len());
        v.iter().for_each(|x| self.raw(&x.to_bits().to_le_bytes()));
    }
    fn str(&mut self, s: &str) {
        self.len(s.len());
        self.raw(s.as_bytes());
    }
    fn opt<T>(&mut self, v: Option<T>, f: impl FnOnce(&mut Self, T)) {
        self.bool(v.is_some());
        if let Some(v) = v {
            f(self, v);
        }
    }
    fn opt_str(&mut self, v: &Option<String>) {
        self.opt(v.as_deref(), |h, s| h.str(s));
    }
}

/// Lowercase hex SHA-256 over the whole result (see the module docs for the
/// two excluded field kinds).
pub fn result_fingerprint(result: &ProcessingResult, include_timings: bool) -> String {
    let ProcessingResult {
        meshes,
        instances,
        mesh_coordinate_space,
        frame,
        site_transform,
        building_transform,
        metadata,
        stats,
    } = result;
    let mut h = Fp(Sha256::new());
    h.raw(b"ifc-lite-result-fingerprint-v1");
    h.len(meshes.len());
    let mut texture_owner: HashMap<*const Vec<u8>, usize> = HashMap::new();
    for (index, mesh) in meshes.iter().enumerate() {
        mesh_fp(&mut h, mesh, index, &mut texture_owner);
    }
    h.len(instances.len());
    instances.iter().for_each(|r| instance_record_fp(&mut h, r));
    h.u8(*mesh_coordinate_space as u8);
    frame_fp(&mut h, frame);
    h.opt(site_transform.as_deref(), |h, v| h.f64s(v));
    h.opt(building_transform.as_deref(), |h, v| h.f64s(v));
    metadata_fp(&mut h, metadata);
    stats_fp(&mut h, stats, include_timings);
    h.0.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn mesh_fp(h: &mut Fp, mesh: &MeshData, index: usize, owners: &mut HashMap<*const Vec<u8>, usize>) {
    let MeshData {
        express_id,
        ifc_type,
        global_id,
        name,
        presentation_layer,
        positions,
        normals,
        indices,
        color,
        material_name,
        geometry_item_id,
        material_id,
        properties,
        uvs,
        texture,
        geometry_class,
        origin,
        instance,
        local_bounds,
        local_to_world,
        presentation,
    } = mesh;
    h.u32(*express_id);
    h.str(ifc_type);
    h.opt_str(global_id);
    h.opt_str(name);
    h.opt_str(presentation_layer);
    h.f32s(positions);
    h.f32s(normals);
    h.len(indices.len());
    indices.iter().for_each(|i| h.u32(*i));
    h.f32s(color);
    h.opt_str(material_name);
    h.opt(*geometry_item_id, |h, v| h.u32(v));
    h.opt(*material_id, |h, v| h.u32(v));
    h.opt(properties.as_ref(), |h, map| {
        h.len(map.len());
        for (k, v) in map {
            h.str(k);
            h.str(v);
        }
    });
    h.opt(uvs.as_deref(), |h, v| h.f32s(v));
    h.opt(texture.as_ref(), |h, t| texture_fp(h, t, index, owners));
    h.u8(*geometry_class);
    h.f64s(origin);
    h.opt(instance.as_ref(), instance_meta_fp);
    h.opt(local_bounds.as_ref(), |h, v| h.f32s(v));
    h.opt(local_to_world.as_ref(), |h, v| h.f64s(v));
    h.opt(presentation.as_deref(), presentation_fp);
}

fn texture_fp(h: &mut Fp, t: &MeshTextureData, index: usize, owners: &mut HashMap<*const Vec<u8>, usize>) {
    let MeshTextureData { texture_id, rgba, width, height, url, repeat_s, repeat_t } = t;
    h.u32(*texture_id);
    h.opt(rgba.as_ref(), |h, rgba| {
        // The allocation's first owner, so a replay that duplicates (or merges)
        // shared pixels differs even when the bytes agree.
        let owner = *owners.entry(std::sync::Arc::as_ptr(rgba)).or_insert(index);
        h.len(owner);
        h.len(rgba.len());
        h.raw(rgba);
    });
    h.u32(*width);
    h.u32(*height);
    h.opt_str(url);
    h.bool(*repeat_s);
    h.bool(*repeat_t);
}

fn instance_meta_fp(h: &mut Fp, m: &InstanceMeta) {
    let InstanceMeta { transform, local_transform, canonical_transform, rep_identity, instanceable } = m;
    h.f64s(transform);
    h.opt(local_transform.as_ref(), |h, v| h.f64s(v));
    h.opt(canonical_transform.as_ref(), |h, v| h.f64s(v));
    h.raw(&rep_identity.to_le_bytes());
    h.bool(*instanceable);
}

fn presentation_fp(h: &mut Fp, p: &MeshPresentationProvenance) {
    let MeshPresentationProvenance { normals, palette, texture } = p;
    h.u8(match normals {
        NormalProvenance::Producer => 0,
        NormalProvenance::RecomputedAfterWindingRepair => 1,
        NormalProvenance::RecomputedMissing => 2,
    });
    h.opt(palette.as_ref(), |h, p| match *p {
        PaletteBinding::Bound { map_id, face_set_id, palette_index } => {
            h.u8(0);
            [map_id, face_set_id, palette_index].iter().for_each(|v| h.u32(*v));
        }
        PaletteBinding::Absent { map_id, reason } => {
            h.u8(1);
            h.u32(map_id);
            h.u8(match reason {
                PaletteAbsence::Malformed => 0,
                PaletteAbsence::Retopologized => 1,
                PaletteAbsence::Unproven => 2,
                PaletteAbsence::StyleOverride => 3,
                PaletteAbsence::SupersededByTexture => 4,
                PaletteAbsence::FixedDisplayColour => 5,
            });
        }
    });
    h.opt(texture.as_ref(), |h, t| {
        let TextureBinding { texture_id, face_set_id, uv_authority } = t;
        h.u32(*texture_id);
        h.opt(*face_set_id, |h, v| h.u32(v));
        h.u8(match uv_authority {
            UvAuthority::Authored => 0,
            UvAuthority::CoordinatePaired => 1,
            UvAuthority::Fabricated => 2,
            UvAuthority::UnknownMap => 3,
            UvAuthority::Dropped => 4,
        });
    });
}

fn instance_record_fp(h: &mut Fp, r: &InstanceRecord) {
    let InstanceRecord {
        express_id,
        ifc_type,
        global_id,
        name,
        presentation_layer,
        color,
        template_express_id,
        rep_identity,
        transform,
        geometry_item_id,
    } = r;
    h.u32(*express_id);
    h.str(ifc_type);
    h.opt_str(global_id);
    h.opt_str(name);
    h.opt_str(presentation_layer);
    h.f32s(color);
    h.u32(*template_express_id);
    h.raw(&rep_identity.to_le_bytes());
    h.f32s(transform);
    h.opt(*geometry_item_id, |h, v| h.u32(v));
}

fn frame_fp(h: &mut Fp, frame: &MeshFrame) {
    match frame {
        MeshFrame::SiteLocal { placement } => {
            h.u8(0);
            h.f64s(placement);
        }
        MeshFrame::ModelRtc { anchor } => {
            h.u8(1);
            h.f64s(&[anchor.0, anchor.1, anchor.2]);
        }
        MeshFrame::RawIfc => h.u8(2),
    }
}

fn metadata_fp(h: &mut Fp, m: &ModelMetadata) {
    let ModelMetadata {
        schema_version,
        entity_count,
        geometry_entity_count,
        coordinate_info,
        length_unit_scale,
        length_unit_refused,
        georeferencing,
    } = m;
    h.str(schema_version);
    h.len(*entity_count);
    h.len(*geometry_entity_count);
    let CoordinateInfo { origin_shift, is_geo_referenced } = coordinate_info;
    h.f64s(origin_shift);
    h.bool(*is_geo_referenced);
    h.opt(*length_unit_scale, |h, v| h.f64s(&[v]));
    h.opt(*length_unit_refused, |h, v| h.u32(v));
    h.opt(georeferencing.as_ref(), georef_fp);
}

fn georef_fp(h: &mut Fp, g: &Georeferencing) {
    let Georeferencing {
        crs_name,
        geodetic_datum,
        vertical_datum,
        map_projection,
        eastings,
        northings,
        orthogonal_height,
        x_axis_abscissa,
        x_axis_ordinate,
        scale,
        factor_x,
        factor_y,
        factor_z,
        rotation_degrees,
        transform_matrix,
        crs_description,
        map_zone,
        map_unit,
        map_unit_scale,
        source,
    } = g;
    [crs_name, geodetic_datum, vertical_datum, map_projection].into_iter().for_each(|s| h.opt_str(s));
    h.f64s(&[
        *eastings,
        *northings,
        *orthogonal_height,
        *x_axis_abscissa,
        *x_axis_ordinate,
        *scale,
        *factor_x,
        *factor_y,
        *factor_z,
        *rotation_degrees,
    ]);
    h.f64s(transform_matrix);
    [crs_description, map_zone, map_unit].into_iter().for_each(|s| h.opt_str(s));
    h.opt(*map_unit_scale, |h, v| h.f64s(&[v]));
    h.opt_str(source);
}

fn stats_fp(h: &mut Fp, s: &ProcessingStats, include_timings: bool) {
    let ProcessingStats {
        total_meshes,
        total_vertices,
        total_triangles,
        parse_time_ms,
        entity_scan_time_ms,
        lookup_time_ms,
        preprocess_time_ms,
        geometry_time_ms,
        total_time_ms,
        from_cache: _,
        total_csg_failures,
        products_with_failures,
        degenerate_triangles_dropped,
        refused_input_elements,
        refused_prepass_records,
        point_cache_hits,
        point_cache_misses,
        faceted_brep_time_ms,
        geometry_diagnostics,
    } = s;
    [total_meshes, total_vertices, total_triangles].into_iter().for_each(|v| h.len(*v));
    if include_timings {
        let timings = [
            parse_time_ms,
            entity_scan_time_ms,
            lookup_time_ms,
            preprocess_time_ms,
            geometry_time_ms,
            total_time_ms,
            faceted_brep_time_ms,
        ];
        timings.into_iter().for_each(|v| h.u64(*v));
    }
    let counters = [
        total_csg_failures,
        products_with_failures,
        degenerate_triangles_dropped,
        refused_input_elements,
        refused_prepass_records,
        point_cache_hits,
        point_cache_misses,
    ];
    counters.into_iter().for_each(|v| h.u64(*v));
    h.opt(geometry_diagnostics.as_ref(), diagnostics_fp);
}

fn diagnostics_fp(h: &mut Fp, d: &GeometryDiagnostics) {
    // The geometry crate owns these structs; its serde form names every field
    // and carries no floats beyond the f32 host boxes, which JSON prints
    // shortest-round-trip. Destructured so a new field is still a decision.
    let GeometryDiagnostics {
        schema_version: _,
        total_csg_failures: _,
        products_with_failures: _,
        hosts_with_openings: _,
        classification: _,
        failures_by_reason: _,
        silent_no_ops: _,
        rect_fast: _,
        worst_hosts: _,
        oversized_ref_drops: _,
        total_unsupported_items: _,
        unsupported_items_by_type: _,
    } = d;
    let json = serde_json::to_vec(d).expect("GeometryDiagnostics serializes");
    h.len(json.len());
    h.raw(&json);
}
