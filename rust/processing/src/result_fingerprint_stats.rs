// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The metadata, stats and diagnostics half of [`super::result_fingerprint`].

use super::Fp;
use crate::types::response::{CoordinateInfo, ModelMetadata, ProcessingStats};
use crate::Georeferencing;
use ifc_lite_geometry::{
    ClassificationSummary, GeometryDiagnostics, HostBbox, ReasonCount, RectFastSummary, WorstHost,
};

pub(super) fn metadata_fp(h: &mut Fp, m: &ModelMetadata) {
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

pub(super) fn stats_fp(h: &mut Fp, s: &ProcessingStats, include_timings: bool) {
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
    // Walked field by field with raw float bits (PR #9614 review finding 5:
    // a JSON form printed every non-finite f32 as `null`, so two different
    // NaN payloads in a host box fingerprinted alike). Every nested struct is
    // destructured in full, so a new diagnostic field is a compile error here.
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
    h.u32(*schema_version);
    [total_csg_failures, products_with_failures, hosts_with_openings].into_iter().for_each(|v| h.u64(*v));
    let ClassificationSummary { rectangular, diagonal, non_rectangular, total } = classification;
    [rectangular, diagonal, non_rectangular, total].into_iter().for_each(|v| h.u64(*v));
    reasons_fp(h, failures_by_reason);
    h.u64(*silent_no_ops);
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
    rect.into_iter().for_each(|v| h.u64(*v));
    h.len(worst_hosts.len());
    for host in worst_hosts {
        let WorstHost { product_id, ifc_type, openings, csg_failures, first_failure_label, bbox, triangle_count } =
            host;
        h.u32(*product_id);
        h.str(ifc_type);
        h.u64(*openings);
        h.u64(*csg_failures);
        h.opt_str(first_failure_label);
        h.opt(bbox.as_ref(), |h, HostBbox { min, max }| {
            h.f32s(min);
            h.f32s(max);
        });
        h.opt(*triangle_count, |h, v| h.u64(v));
    }
    h.u64(*oversized_ref_drops);
    h.u64(*total_unsupported_items);
    reasons_fp(h, unsupported_items_by_type);
}

fn reasons_fp(h: &mut Fp, reasons: &[ReasonCount]) {
    h.len(reasons.len());
    for ReasonCount { reason, count } in reasons {
        h.str(reason);
        h.u64(*count);
    }
}
