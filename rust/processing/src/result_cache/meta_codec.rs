// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The META section: mesh frame, site/building transforms, model metadata and
//! processing stats with their geometry diagnostics. Each struct is
//! destructured in full on encode and built field by field on decode, so a new
//! field cannot be silently dropped from the snapshot. Enum tags are this
//! codec's own constants, never serde ordinals.

use super::wire::{Reader, Writer};
use super::CodecError;
use crate::types::response::{CoordinateInfo, ModelMetadata, ProcessingStats};
use crate::{Georeferencing, MeshCoordinateSpace, MeshFrame};
use ifc_lite_geometry::{
    ClassificationSummary, GeometryDiagnostics, HostBbox, ReasonCount, RectFastSummary, WorstHost,
};

/// The META section's parts, borrowed from the result being encoded.
pub(super) struct MetaRef<'a> {
    pub(super) mesh_coordinate_space: MeshCoordinateSpace,
    pub(super) frame: &'a MeshFrame,
    pub(super) site_transform: &'a Option<Vec<f64>>,
    pub(super) building_transform: &'a Option<Vec<f64>>,
    pub(super) metadata: &'a ModelMetadata,
    pub(super) stats: &'a ProcessingStats,
}

pub(super) struct Meta {
    pub(super) mesh_coordinate_space: MeshCoordinateSpace,
    pub(super) frame: MeshFrame,
    pub(super) site_transform: Option<Vec<f64>>,
    pub(super) building_transform: Option<Vec<f64>>,
    pub(super) metadata: ModelMetadata,
    pub(super) stats: ProcessingStats,
}

fn space_tag(space: MeshCoordinateSpace) -> u8 {
    match space {
        MeshCoordinateSpace::SiteLocal => 0,
        MeshCoordinateSpace::ModelRtc => 1,
        MeshCoordinateSpace::RawIfc => 2,
    }
}

pub(super) fn encode_meta(w: &mut Writer, m: &MetaRef<'_>) {
    w.u8(space_tag(m.mesh_coordinate_space));
    match m.frame {
        MeshFrame::SiteLocal { placement } => {
            w.u8(0);
            w.f64_fixed(placement);
        }
        MeshFrame::ModelRtc { anchor } => {
            w.u8(1);
            w.f64_fixed(&[anchor.0, anchor.1, anchor.2]);
        }
        MeshFrame::RawIfc => w.u8(2),
    }
    w.opt(m.site_transform.as_deref(), Writer::f64_vec);
    w.opt(m.building_transform.as_deref(), Writer::f64_vec);
    encode_metadata(w, m.metadata);
    encode_stats(w, m.stats);
}

pub(super) fn decode_meta(r: &mut Reader<'_>) -> Result<Meta, CodecError> {
    let mesh_coordinate_space = match r.u8()? {
        0 => MeshCoordinateSpace::SiteLocal,
        1 => MeshCoordinateSpace::ModelRtc,
        2 => MeshCoordinateSpace::RawIfc,
        _ => return Err(CodecError::Malformed("meta", "unknown coordinate space")),
    };
    let frame = match r.u8()? {
        0 => MeshFrame::SiteLocal { placement: r.f64_fixed()? },
        1 => {
            let [x, y, z] = r.f64_fixed()?;
            MeshFrame::ModelRtc { anchor: (x, y, z) }
        }
        2 => MeshFrame::RawIfc,
        _ => return Err(CodecError::Malformed("meta", "unknown frame")),
    };
    Ok(Meta {
        mesh_coordinate_space,
        frame,
        site_transform: r.opt(Reader::f64_vec)?,
        building_transform: r.opt(Reader::f64_vec)?,
        metadata: decode_metadata(r)?,
        stats: decode_stats(r)?,
    })
}

fn encode_metadata(w: &mut Writer, m: &ModelMetadata) {
    let ModelMetadata {
        schema_version,
        entity_count,
        geometry_entity_count,
        coordinate_info,
        length_unit_scale,
        length_unit_refused,
        georeferencing,
    } = m;
    w.str(schema_version);
    w.len(*entity_count);
    w.len(*geometry_entity_count);
    let CoordinateInfo { origin_shift, is_geo_referenced } = coordinate_info;
    w.f64_fixed(origin_shift);
    w.bool(*is_geo_referenced);
    w.opt(*length_unit_scale, Writer::f64);
    w.opt_u32(*length_unit_refused);
    w.opt(georeferencing.as_ref(), encode_georef);
}

fn decode_metadata(r: &mut Reader<'_>) -> Result<ModelMetadata, CodecError> {
    Ok(ModelMetadata {
        schema_version: r.str()?,
        entity_count: r.usize()?,
        geometry_entity_count: r.usize()?,
        coordinate_info: CoordinateInfo { origin_shift: r.f64_fixed()?, is_geo_referenced: r.bool()? },
        length_unit_scale: r.opt(Reader::f64)?,
        length_unit_refused: r.opt_u32()?,
        georeferencing: r.opt(decode_georef)?,
    })
}

fn encode_georef(w: &mut Writer, g: &Georeferencing) {
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
    [crs_name, geodetic_datum, vertical_datum, map_projection].into_iter().for_each(|s| w.opt_str(s));
    w.f64_fixed(&[
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
    w.f64_fixed(transform_matrix);
    [crs_description, map_zone, map_unit].into_iter().for_each(|s| w.opt_str(s));
    w.opt(*map_unit_scale, Writer::f64);
    w.opt_str(source);
}

fn decode_georef(r: &mut Reader<'_>) -> Result<Georeferencing, CodecError> {
    let [crs_name, geodetic_datum, vertical_datum, map_projection] =
        [r.opt_str()?, r.opt_str()?, r.opt_str()?, r.opt_str()?];
    let [eastings, northings, orthogonal_height, x_axis_abscissa, x_axis_ordinate, scale, factor_x, factor_y, factor_z, rotation_degrees] =
        r.f64_fixed::<10>()?;
    Ok(Georeferencing {
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
        transform_matrix: r.f64_fixed()?,
        crs_description: r.opt_str()?,
        map_zone: r.opt_str()?,
        map_unit: r.opt_str()?,
        map_unit_scale: r.opt(Reader::f64)?,
        source: r.opt_str()?,
    })
}

fn encode_stats(w: &mut Writer, s: &ProcessingStats) {
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
        from_cache,
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
    [total_meshes, total_vertices, total_triangles].into_iter().for_each(|v| w.len(*v));
    let u64s = [
        parse_time_ms,
        entity_scan_time_ms,
        lookup_time_ms,
        preprocess_time_ms,
        geometry_time_ms,
        total_time_ms,
        total_csg_failures,
        products_with_failures,
        degenerate_triangles_dropped,
        refused_input_elements,
        refused_prepass_records,
        point_cache_hits,
        point_cache_misses,
        faceted_brep_time_ms,
    ];
    u64s.into_iter().for_each(|v| w.u64(*v));
    w.bool(*from_cache);
    w.opt(geometry_diagnostics.as_ref(), encode_diagnostics);
}

fn decode_stats(r: &mut Reader<'_>) -> Result<ProcessingStats, CodecError> {
    let [total_meshes, total_vertices, total_triangles] = [r.usize()?, r.usize()?, r.usize()?];
    let mut u64s = [0u64; 14];
    for v in &mut u64s {
        *v = r.u64()?;
    }
    let [parse_time_ms, entity_scan_time_ms, lookup_time_ms, preprocess_time_ms, geometry_time_ms, total_time_ms, total_csg_failures, products_with_failures, degenerate_triangles_dropped, refused_input_elements, refused_prepass_records, point_cache_hits, point_cache_misses, faceted_brep_time_ms] =
        u64s;
    Ok(ProcessingStats {
        total_meshes,
        total_vertices,
        total_triangles,
        parse_time_ms,
        entity_scan_time_ms,
        lookup_time_ms,
        preprocess_time_ms,
        geometry_time_ms,
        total_time_ms,
        from_cache: r.bool()?,
        total_csg_failures,
        products_with_failures,
        degenerate_triangles_dropped,
        refused_input_elements,
        refused_prepass_records,
        point_cache_hits,
        point_cache_misses,
        faceted_brep_time_ms,
        geometry_diagnostics: r.opt(decode_diagnostics)?,
    })
}

fn encode_reasons(w: &mut Writer, reasons: &[ReasonCount]) {
    w.len(reasons.len());
    for ReasonCount { reason, count } in reasons {
        w.str(reason);
        w.u64(*count);
    }
}

fn decode_reasons(r: &mut Reader<'_>) -> Result<Vec<ReasonCount>, CodecError> {
    let n = r.count(16)?;
    (0..n).map(|_| Ok(ReasonCount { reason: r.str()?, count: r.u64()? })).collect()
}

fn encode_diagnostics(w: &mut Writer, d: &GeometryDiagnostics) {
    let GeometryDiagnostics {
        schema_version,
        total_csg_failures,
        products_with_failures,
        hosts_with_openings,
        classification,
        failures_by_reason,
        silent_no_ops,
        rect_fast,
        worst_hosts,
        oversized_ref_drops,
        total_unsupported_items,
        unsupported_items_by_type,
    } = d;
    w.u32(*schema_version);
    [total_csg_failures, products_with_failures, hosts_with_openings].into_iter().for_each(|v| w.u64(*v));
    let ClassificationSummary { rectangular, diagonal, non_rectangular, total } = classification;
    [rectangular, diagonal, non_rectangular, total].into_iter().for_each(|v| w.u64(*v));
    encode_reasons(w, failures_by_reason);
    w.u64(*silent_no_ops);
    let RectFastSummary {
        fired,
        openings_cut,
        defer_host_not_box,
        defer_not_through,
        defer_off_face,
        defer_near_edge,
        defer_no_openings,
        defer_too_many_openings,
    } = rect_fast;
    let rect = [
        fired,
        openings_cut,
        defer_host_not_box,
        defer_not_through,
        defer_off_face,
        defer_near_edge,
        defer_no_openings,
        defer_too_many_openings,
    ];
    rect.into_iter().for_each(|v| w.u64(*v));
    w.len(worst_hosts.len());
    for host in worst_hosts {
        let WorstHost { product_id, ifc_type, openings, csg_failures, first_failure_label, bbox, triangle_count } =
            host;
        w.u32(*product_id);
        w.str(ifc_type);
        w.u64(*openings);
        w.u64(*csg_failures);
        w.opt_str(first_failure_label);
        w.opt(bbox.as_ref(), |w, HostBbox { min, max }| {
            w.f32_fixed(min);
            w.f32_fixed(max);
        });
        w.opt(*triangle_count, Writer::u64);
    }
    w.u64(*oversized_ref_drops);
    w.u64(*total_unsupported_items);
    encode_reasons(w, unsupported_items_by_type);
}

fn decode_diagnostics(r: &mut Reader<'_>) -> Result<GeometryDiagnostics, CodecError> {
    let schema_version = r.u32()?;
    let [total_csg_failures, products_with_failures, hosts_with_openings] = [r.u64()?, r.u64()?, r.u64()?];
    let classification =
        ClassificationSummary { rectangular: r.u64()?, diagonal: r.u64()?, non_rectangular: r.u64()?, total: r.u64()? };
    let failures_by_reason = decode_reasons(r)?;
    let silent_no_ops = r.u64()?;
    let rect_fast = RectFastSummary {
        fired: r.u64()?,
        openings_cut: r.u64()?,
        defer_host_not_box: r.u64()?,
        defer_not_through: r.u64()?,
        defer_off_face: r.u64()?,
        defer_near_edge: r.u64()?,
        defer_no_openings: r.u64()?,
        defer_too_many_openings: r.u64()?,
    };
    let hosts = r.count(31)?; // smallest WorstHost record
    let worst_hosts = (0..hosts)
        .map(|_| {
            Ok(WorstHost {
                product_id: r.u32()?,
                ifc_type: r.str()?,
                openings: r.u64()?,
                csg_failures: r.u64()?,
                first_failure_label: r.opt_str()?,
                bbox: r.opt(|r| Ok(HostBbox { min: r.f32_fixed()?, max: r.f32_fixed()? }))?,
                triangle_count: r.opt(Reader::u64)?,
            })
        })
        .collect::<Result<Vec<_>, CodecError>>()?;
    Ok(GeometryDiagnostics {
        schema_version,
        total_csg_failures,
        products_with_failures,
        hosts_with_openings,
        classification,
        failures_by_reason,
        silent_no_ops,
        rect_fast,
        worst_hosts,
        oversized_ref_drops: r.u64()?,
        total_unsupported_items: r.u64()?,
        unsupported_items_by_type: decode_reasons(r)?,
    })
}
