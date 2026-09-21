// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

mod methods;

#[wasm_bindgen]
extern "C" {
    /// The serialized semantic source record emitted by `parseLandXmlTinBytes`.
    #[wasm_bindgen(typescript_type = "LandXmlTinDocumentJs")]
    pub type LandXmlTinDocumentJs;
    /// The complete, source-level LandXML record emitted by
    /// `parseLandXmlSourceBytes`. `tin` and `alignments` preserve their own
    /// source semantics; neither is converted into invented IFC entities.
    #[wasm_bindgen(typescript_type = "LandXmlSourceDocumentJs")]
    pub type LandXmlSourceDocumentJs;
    #[wasm_bindgen(typescript_type = "LandXmlAlignmentProbeJs")]
    pub type LandXmlAlignmentProbeJs;
    #[wasm_bindgen(typescript_type = "LandXmlAlignmentProbesJs")]
    pub type LandXmlAlignmentProbesJs;
    #[wasm_bindgen(typescript_type = "LandXmlAlignmentInspectionJs")]
    pub type LandXmlAlignmentInspectionJs;
    #[wasm_bindgen(typescript_type = "LandXmlParseOptionsJs")]
    pub type LandXmlParseOptionsJs;
}

#[wasm_bindgen(typescript_custom_section)]
const LANDXML_TYPES: &str = r#"
export interface LandXmlTinDocumentJs {
  format: "landxml";
  schema: "LandXML-1.0" | "LandXML-1.1" | "LandXML-1.2";
  capabilities: { renderable_tin: boolean; preserved_only_surfaces: number; unknown_extensions: number };
  version: string;
  /** serde_wasm_bindgen omits an absent Rust Option field rather than serializing null. */
  units?: { linear_unit: string; elevation_unit: string; linear_scale_to_meters: number; elevation_scale_to_meters: number };
  surfaces: LandXmlSurfaceJs[];
  pipe_networks?: LandXmlPipeNetworkDocumentJs;
  extensions: LandXmlExtensionJs[];
  warnings: string[];
  alignments: LandXmlAlignmentSummaryJs[]; profiles: LandXmlProfileJs[];
  cross_sections: LandXmlCrossSectionJs[]; cross_section_surfaces: LandXmlCrossSectionSurfaceJs[];
  roadways: LandXmlRoadwayJs[]; capability_diagnostics: LandXmlCapabilityDiagnosticJs[];
  preserved_only_extensions: LandXmlPreservedOnlyExtensionJs[];
  /** COGO, parcel and plan-feature records from the same source bytes. */
  plan: LandXmlPlanDocumentJs;
}
export interface LandXmlPlanDocumentJs {
  schema: "LandXML-1.0" | "LandXML-1.1" | "LandXML-1.2"; version: string;
  capability_diagnostics: LandXmlCapabilityDiagnosticJs[];
  area_unit?: string; area_scale_to_square_meters?: number;
  cogo_points: LandXmlCgPointJs[]; monuments: LandXmlMonumentJs[];
  plan_features: LandXmlPlanFeatureJs[]; parcels: LandXmlParcelJs[]; warnings: string[];
  source_batches: LandXmlPlanSourceBatchJs[]; parcel_probes: LandXmlParcelProbeJs[];
  resolved_monuments: LandXmlResolvedMonumentJs[]; resolved_geometry: LandXmlResolvedGeometryJs[];
}
export interface LandXmlPlanSourceBatchJs { source_ids: string[]; }
export interface LandXmlParcelProbeJs { source_id: string; state: { kind: "analytic" } | { kind: "preserved_only"; reason: string }; perimeter_in_declared_linear_units?: number; area_in_declared_square_units?: number; declared_area?: number; declared_perimeter?: number; perimeter_in_meters?: number; area_in_square_meters?: number; }
export interface LandXmlResolvedMonumentJs { source_id: string; point?: LandXmlPlanPointJs; }
export interface LandXmlResolvedGeometryJs { source_id: string; start?: LandXmlPlanPointJs; end?: LandXmlPlanPointJs; center?: LandXmlPlanPointJs; pi?: LandXmlPlanPointJs; }
export interface LandXmlPlanPointJs { northing: number; easting: number; elevation?: number; }
export interface LandXmlCgPointJs { source_id: string; scope_id: string; ordinal: number; name?: string; code?: string; description?: string; point?: LandXmlPlanPointJs; pnt_ref?: string; properties: Record<string, string>; }
export interface LandXmlMonumentJs { source_id: string; point_scope_id?: string; ordinal: number; name?: string; code?: string; description?: string; pnt_ref?: string; point?: LandXmlPlanPointJs; properties: Record<string, string>; }
export interface LandXmlPlanFeatureJs { source_id: string; ordinal: number; name?: string; code?: string; description?: string; properties: Record<string, string>; locations: LandXmlPlanPointLocationJs[]; geometry: LandXmlPlanGeometryJs[]; }
export interface LandXmlParcelJs { source_id: string; ordinal: number; name?: string; code?: string; description?: string; title?: string; declared_area?: number; declared_perimeter?: number; declared_area_unit?: string; properties: Record<string, string>; loops: LandXmlPlanGeometryJs[][]; preservation_reason?: string; }
export interface LandXmlPlanGeometryJs { source_id: string; ordinal: number; kind: "line" | "curve" | "irregular_line"; point_scope_id?: string; start: LandXmlPlanPointLocationJs; end: LandXmlPlanPointLocationJs; center?: LandXmlPlanPointLocationJs; pi?: LandXmlPlanPointLocationJs; intermediate_points: LandXmlPlanPointJs[]; rotation?: string; radius?: number; declared_length?: number; properties: Record<string, string>; }
export type LandXmlPlanPointLocationJs = { kind: "coordinates"; point: LandXmlPlanPointJs; pnt_ref?: string } | { kind: "point_reference"; pnt_ref: string };
export interface LandXmlSurfaceJs {
  source_id: string; ordinal: number; source_path: string;
  properties: Record<string, string>; definition_properties: Record<string, string>;
  name: string; kind: "tin" | "grid" | "volume" | "other";
  render_state: "rendered" | "preserved_only" | "unsupported";
  topology_origin: "authored_faces" | "constrained_triangulation" | "preserved_only";
  terrain_diagnostic?: { code: "missing_outer_boundary" | "unsupported_boundary_semantics" | "unsupported_breakline_semantics" | "missing_elevation" | "conflicting_elevation" | "intersecting_constraints" | "degenerate_constraints" | "work_limit_exceeded" | "cancelled"; message: string };
  points: LandXmlPointJs[]; canonical_vertices: LandXmlCanonicalVertexJs[]; source_data_points: LandXmlSourcePointJs[];
  faces: [string, string, string][]; face_source_ids: string[]; face_visibility: boolean[];
  hidden_face_count: number; boundaries: LandXmlPolylineJs[]; breaklines: LandXmlPolylineJs[]; contours: LandXmlPolylineJs[];
}
export interface LandXmlPointJs { source_id: string; id: string; northing: number; easting: number; elevation: number; }
export interface LandXmlCanonicalVertexJs { id: string; northing: number; easting: number; elevation: number; contributor_source_ids: string[]; }
export interface LandXmlSourcePointJs { source_id: string; ordinal: number; source_path: string; coordinate_dimension: 2 | 3; coordinates: number[]; }
/** serde_wasm_bindgen omits absent Rust Option fields rather than serializing null. */
export interface LandXmlPolylineJs { source_id: string; ordinal: number; name?: string; kind?: string; source_path: string; properties: Record<string, string>; coordinate_dimension: 2 | 3; points: number[][]; point_source_ids: string[]; }
export interface LandXmlExtensionJs { namespace: string; local_name: string; path: string; }
export interface LandXmlSourceDocumentJs { tin: LandXmlTinDocumentJs; alignments: LandXmlAlignmentDocumentJs; alignment_render_spans: LandXmlAlignmentRenderSpanJs[]; alignment_render_refusals: LandXmlAlignmentRenderRefusalJs[]; alignment_render_truncated: boolean; }
export interface LandXmlAlignmentRenderSpanJs { source_id: string; points: LandXmlPlanPointJs[]; }
export interface LandXmlAlignmentRenderRefusalJs { source_id: string; message: string; }
export interface LandXmlAlignmentDocumentJs {
  schema: "LandXML-1.0" | "LandXML-1.1" | "LandXML-1.2"; version: string;
  capability_diagnostics: LandXmlCapabilityDiagnosticJs[];
  units?: LandXmlUnitsJs; alignments: LandXmlAlignmentJs[]; warnings: string[];
}
export interface LandXmlUnitsJs { linear_unit: string; elevation_unit: string; linear_scale_to_meters: number; elevation_scale_to_meters: number; }
/** Terrain-parser alignment linkage; use LandXmlAlignmentDocumentJs for complete alignment semantics. */
export interface LandXmlAlignmentSummaryJs { source_id: string; ordinal: number; name: string; length: number; sta_start: number; profile_source_ids: string[]; cross_section_source_ids: string[]; }
export interface LandXmlAlignmentJs { source_id: string; ordinal: number; name: string; length: number; sta_start: number; start?: LandXmlPointLocationJs; align_pis: LandXmlAlignmentPiJs[]; segments: LandXmlAlignmentSegmentJs[]; station_equations: LandXmlStationEquationJs[]; cant?: LandXmlCantJs; superelevations: LandXmlSuperelevationJs[]; unsupported_transitions: LandXmlUnsupportedTransitionJs[]; }
export type LandXmlPointLocationJs = { kind: "coordinates"; point: LandXmlPlanPointJs } | { kind: "point_reference"; pnt_ref: string };
export interface LandXmlAlignmentPiJs { source_id: string; location: LandXmlPointLocationJs; }
export type LandXmlAlignmentSegmentJs = { source_id: string; ordinal: number; primitive: LandXmlAlignmentPrimitiveJs };
export interface LandXmlSpiralJs { start: LandXmlPointLocationJs; pi: LandXmlPointLocationJs; end: LandXmlPointLocationJs; spi_type: string; radius_start: LandXmlRadiusJs; radius_end: LandXmlRadiusJs; rotation: "clockwise" | "counter_clockwise"; declared_length: number; }
export type LandXmlAlignmentPrimitiveJs = { kind: "line"; start: LandXmlPointLocationJs; end: LandXmlPointLocationJs; declared_length?: number } | { kind: "irregular_line"; start: LandXmlPointLocationJs; end: LandXmlPointLocationJs; points: LandXmlPlanPointJs[]; declared_length?: number } | { kind: "curve"; start: LandXmlPointLocationJs; center: LandXmlPointLocationJs; end: LandXmlPointLocationJs; pi?: LandXmlPointLocationJs; rotation: "clockwise" | "counter_clockwise"; radius?: number; declared_length?: number } | ({ kind: "spiral" } & LandXmlSpiralJs) | ({ kind: "unsupported_spiral" } & LandXmlSpiralJs);
export type LandXmlRadiusJs = { finite: number } | "infinite";
export interface LandXmlStationEquationJs { source_id: string; sta_internal: number; sta_ahead: number; sta_back?: number; sta_increment?: string; }
export interface LandXmlCantJs { source_id: string; name: string; gauge: number; rotation_point?: string; equilibrium_constant?: number; applied_cant_constant?: number; stations: LandXmlCantStationJs[]; speed_stations: LandXmlSpeedStationJs[]; }
export interface LandXmlCantStationJs { source_id: string; station: number; applied_cant: number; equilibrium_cant?: number; curvature: "clockwise" | "counter_clockwise"; cant_deficiency?: number; cant_excess?: number; rate_of_change_of_applied_cant_over_time?: number; rate_of_change_of_applied_cant_over_length?: number; rate_of_change_of_cant_deficiency_over_time?: number; cant_gradient?: number; speed?: number; transition_type?: string; adverse?: boolean; }
export interface LandXmlSpeedStationJs { source_id: string; station: number; speed: number; }
export interface LandXmlSuperelevationJs { source_id: string; sta_start?: number; sta_end?: number; events: LandXmlSuperelevationEventJs[]; }
export interface LandXmlSuperelevationEventJs { source_id: string; kind: string; value?: string; }
/** `spiral` is the Rust LandXmlSpiral payload, not a tagged primitive enum. */
export interface LandXmlUnsupportedTransitionJs { source_id: string; spi_type: string; spiral: LandXmlSpiralJs; reason: string; }
export interface LandXmlAlignmentProbeJs { alignment_source_id: string; segment_source_id: string; geometric_distance: number; station: { geometric_distance: number; displayed_back: number; displayed_ahead: number; is_equation_boundary: boolean }; northing: number; easting: number; tangent_northing: number; tangent_easting: number; }
export type LandXmlAlignmentProbesJs = LandXmlAlignmentProbeJs[];
/** Neighbouring authored CantStation records; values are never interpolated. */
export interface LandXmlAlignmentInspectionJs { cant?: { internal_station: number; station: { geometric_distance: number; displayed_back: number; displayed_ahead: number; is_equation_boundary: boolean }; previous?: LandXmlCantStationJs; next?: LandXmlCantStationJs }; superelevations: LandXmlSuperelevationJs[]; superelevation_block_count: number; superelevation_event_count: number; superelevation_truncated: boolean; }
export interface LandXmlParseOptionsJs { maxBytes?: number; maxDepth?: number; maxTextBytes?: number; maxPoints?: number; maxFaces?: number; maxWork?: number; maxAlignments?: number; maxAlignmentSegments?: number; maxAlignmentPoints?: number; maxStationEquations?: number; maxCantStations?: number; maxSuperelevationEvents?: number; cancelled?: boolean; }
export interface LandXmlProfilePointJs { source_id: string; station: number; elevation?: number; }
export interface LandXmlGradeLineJs { source_id: string; parent_profile_source_id: string; ordinal: number; points: LandXmlProfilePointJs[]; }
export interface LandXmlVerticalCurveJs { source_id: string; parent_profile_source_id: string; kind: "parabolic" | "unsymmetrical_parabolic" | "circular"; station: number; elevation?: number; length?: number; length_in?: number; length_out?: number; radius?: number; }
export interface LandXmlProfileJs { source_id: string; parent_alignment_source_id: string; ordinal: number; name: string; kind: "design" | "sampled"; pvis: LandXmlProfilePointJs[]; vertical_curves: LandXmlVerticalCurveJs[]; grade_lines: LandXmlGradeLineJs[]; }
export interface LandXmlCrossSectionJs { source_id: string; parent_alignment_source_id: string; ordinal: number; station: number; surface_source_ids: string[]; }
export interface LandXmlCrossSectionPointJs { source_id: string; data_format: "offset_elevation" | "slope_distance"; offset?: number; elevation?: number; slope?: number; distance?: number; pnt_ref?: string; alignment_ref?: string; align_ref_station?: number; alignment_source_id?: string; plan_feature_ref?: string; plan_feature_ref_station?: number; parcel_ref?: string; parcel_ref_station?: number; }
export interface LandXmlCrossSectionSegmentJs { source_id: string; parent_surface_source_id: string; ordinal: number; points: LandXmlCrossSectionPointJs[]; }
export interface LandXmlCrossSectionSurfaceJs { source_id: string; parent_cross_section_source_id: string; kind: "sampled" | "design"; name?: string; segments: LandXmlCrossSectionSegmentJs[]; points: LandXmlCrossSectionPointJs[]; }
export interface LandXmlRoadwayJs { source_id: string; ordinal: number; name: string; alignment_refs: string[]; alignment_source_ids: string[]; surface_refs: string[]; surface_source_ids: string[]; grade_model_refs: string[]; }
export interface LandXmlCapabilityDiagnosticJs { code: string; source_id?: string; source_path: string; message: string; }
export interface LandXmlPreservedOnlyExtensionJs { source_id: string; parent_source_id?: string; local_name: string; source_path: string; kind: "corridor" | "string_line"; }
export interface LandXmlPipeUnitsJs { linear_unit: string; elevation_unit: string; diameter_unit: string; width_unit: string; height_unit: string; flow_unit?: string; linear_scale_to_meters: number; elevation_scale_to_meters: number; diameter_scale_to_meters: number; width_scale_to_meters: number; height_scale_to_meters: number; }
export interface LandXmlPipeNetworkDocumentJs {
  schema: "LandXML-1.0" | "LandXML-1.1" | "LandXML-1.2"; version: string;
  capability_diagnostics: LandXmlCapabilityDiagnosticJs[];
  root_units?: LandXmlPipeUnitsJs; collections: LandXmlPipeCollectionJs[];
  features: LandXmlPipeFeatureJs[]; networks: LandXmlPipeNetworkJs[]; refusals: LandXmlPipeRefusalJs[];
}
export interface LandXmlPipeCollectionJs { source_id: string; source_path: string; properties: Record<string, string>; }
export interface LandXmlPipeFeatureJs { source_id: string; source_path: string; owner_source_id: string; properties: Record<string, string>; }
export interface LandXmlPipeRefusalJs { source_id: string; source_path: string; code: string; message: string; }
export interface LandXmlPipeMeasureJs { value: number; unit: string; meters: number; }
export interface LandXmlPipePositionJs { northing: number; easting: number; northing_meters: number; easting_meters: number; elevation?: LandXmlPipeMeasureJs; }
export interface LandXmlPipeFlowJs { source_id: string; source_path: string; unit?: string; flow_in?: number; loss_in?: number; loss_out?: number; properties: Record<string, string>; }
export interface LandXmlPipeInvertJs { source_id: string; source_path: string; pipe_source_id: string; flow_direction: string; elevation: LandXmlPipeMeasureJs; properties: Record<string, string>; }
export interface LandXmlPipePartJs { kind: "circular" | "elliptical" | "egg" | "rectangular"; properties: Record<string, string>; diameter?: LandXmlPipeMeasureJs; span?: LandXmlPipeMeasureJs; width?: LandXmlPipeMeasureJs; height?: LandXmlPipeMeasureJs; thickness?: LandXmlPipeMeasureJs; material?: string; }
export interface LandXmlStructurePartJs { kind: "circular" | "rectangular" | "inlet" | "outlet" | "connection"; properties: Record<string, string>; diameter?: LandXmlPipeMeasureJs; length?: LandXmlPipeMeasureJs; width?: LandXmlPipeMeasureJs; thickness?: LandXmlPipeMeasureJs; material?: string; }
export interface LandXmlPipeNetworkJs { source_id: string; source_path: string; name: string; pipe_network_type: string; properties: Record<string, string>; features: LandXmlPipeFeatureJs[]; structure_units?: LandXmlPipeUnitsJs; pipe_units?: LandXmlPipeUnitsJs; structures: LandXmlPipeStructureJs[]; pipes: LandXmlPipeJs[]; }
export interface LandXmlPipeStructureJs { source_id: string; source_path: string; name: string; properties: Record<string, string>; units: LandXmlPipeUnitsJs; center: LandXmlPipePositionJs; part: LandXmlStructurePartJs; rim_elevation?: LandXmlPipeMeasureJs; sump_elevation?: LandXmlPipeMeasureJs; inverts: LandXmlPipeInvertJs[]; flow?: LandXmlPipeFlowJs; }
export interface LandXmlPipeJs { source_id: string; source_path: string; name: string; properties: Record<string, string>; units: LandXmlPipeUnitsJs; connectivity: { start_structure_source_id: string; end_structure_source_id: string }; part: LandXmlPipePartJs; geometry: { kind: "straight" | "pass_through"; point?: LandXmlPipePositionJs }; length?: LandXmlPipeMeasureJs; flow?: LandXmlPipeFlowJs; }
"#;

#[derive(Serialize)]
pub(super) struct LandXmlDocumentJs<'a> {
    #[serde(flatten)]
    terrain: &'a ifc_lite_landxml::LandXmlTinDocument,
    plan: LandXmlPlanDocumentJs<'a>,
}

#[derive(Serialize)]
pub(crate) struct LandXmlPlanDocumentJs<'a> {
    schema: &'a str,
    version: &'a str,
    capability_diagnostics: &'a [ifc_lite_landxml::LandXmlCapabilityDiagnostic],
    area_unit: &'a Option<String>,
    area_scale_to_square_meters: Option<f64>,
    cogo_points: &'a [ifc_lite_landxml::LandXmlCgPoint],
    monuments: &'a [ifc_lite_landxml::LandXmlMonument],
    plan_features: &'a [ifc_lite_landxml::LandXmlPlanFeature],
    parcels: &'a [ifc_lite_landxml::LandXmlParcel],
    warnings: &'a [String],
    source_batches: Vec<ifc_lite_landxml::LandXmlPlanSourceBatch>,
    parcel_probes: Vec<LandXmlParcelProbeJs<'a>>,
    resolved_monuments: Vec<LandXmlResolvedMonumentJs<'a>>,
    resolved_geometry: Vec<LandXmlResolvedGeometryJs<'a>>,
}

#[derive(Serialize)]
struct LandXmlParcelProbeJs<'a> {
    source_id: &'a ifc_lite_landxml::LandXmlSourceId,
    #[serde(flatten)]
    probe: ifc_lite_landxml::LandXmlParcelProbe,
}

#[derive(Serialize)]
struct LandXmlResolvedMonumentJs<'a> {
    source_id: &'a ifc_lite_landxml::LandXmlSourceId,
    point: Option<ifc_lite_landxml::LandXmlPlanPoint>,
}

#[derive(Serialize)]
struct LandXmlResolvedGeometryJs<'a> {
    source_id: &'a ifc_lite_landxml::LandXmlSourceId,
    start: Option<ifc_lite_landxml::LandXmlPlanPoint>,
    end: Option<ifc_lite_landxml::LandXmlPlanPoint>,
    center: Option<ifc_lite_landxml::LandXmlPlanPoint>,
    pi: Option<ifc_lite_landxml::LandXmlPlanPoint>,
}

fn resolved_geometry<'a>(
    plan: &'a ifc_lite_landxml::LandXmlPlanDocument,
    resolver: &mut ifc_lite_landxml::LandXmlPlanResolver<'a>,
) -> Result<Vec<LandXmlResolvedGeometryJs<'a>>, ifc_lite_landxml::LandXmlError> {
    plan.plan_features
        .iter()
        .flat_map(|feature| feature.geometry.iter())
        .chain(
            plan.parcels
                .iter()
                .flat_map(|parcel| parcel.loops.iter().flatten()),
        )
        .map(|geometry| {
            Ok(LandXmlResolvedGeometryJs {
                source_id: &geometry.source_id,
                start: resolver.resolve(geometry.point_scope_id.as_ref(), &geometry.start)?,
                end: resolver.resolve(geometry.point_scope_id.as_ref(), &geometry.end)?,
                center: geometry
                    .center
                    .as_ref()
                    .map(|point| resolver.resolve(geometry.point_scope_id.as_ref(), point))
                    .transpose()?
                    .flatten(),
                pi: geometry
                    .pi
                    .as_ref()
                    .map(|point| resolver.resolve(geometry.point_scope_id.as_ref(), point))
                    .transpose()?
                    .flatten(),
            })
        })
        .collect()
}

pub(crate) fn plan_adapter<'a>(
    plan: &'a ifc_lite_landxml::LandXmlPlanDocument,
) -> Result<LandXmlPlanDocumentJs<'a>, ifc_lite_landxml::LandXmlError> {
    // Resolver work is document-wide. Parcel topology has its own checked,
    // per-record bound, so a pathological ring cannot starve later aliases.
    let resolution_requests = plan
        .monuments
        .len()
        .saturating_add(
            plan.plan_features
                .iter()
                .map(|feature| feature.geometry.len().saturating_mul(4))
                .sum::<usize>(),
        )
        .saturating_add(
            plan.parcels
                .iter()
                .map(|parcel| {
                    parcel
                        .loops
                        .iter()
                        .map(|loop_geometry| loop_geometry.len().saturating_mul(4))
                        .sum::<usize>()
                })
                .sum::<usize>(),
        );
    let max_work = plan
        .cogo_points()
        .len()
        .saturating_mul(8)
        .saturating_add(resolution_requests.saturating_mul(8))
        .saturating_add(1_000);
    let mut resolver = ifc_lite_landxml::LandXmlPlanResolver::new(plan, max_work);
    Ok(LandXmlPlanDocumentJs {
        schema: &plan.schema,
        version: &plan.version,
        capability_diagnostics: &plan.capability_diagnostics,
        area_unit: &plan.area_unit,
        area_scale_to_square_meters: plan.area_scale_to_square_meters,
        cogo_points: plan.cogo_points(),
        monuments: &plan.monuments,
        plan_features: &plan.plan_features,
        parcels: &plan.parcels,
        warnings: &plan.warnings,
        // The host consumes these canonical batches through one shared line
        // overlay, never a GPU resource per plan source record.
        source_batches: plan.source_batches(128),
        parcel_probes: plan
            .probe_parcels_with_resolver(&plan.parcels, &mut resolver)?
            .into_iter()
            .zip(plan.parcels.iter())
            .map(|(probe, parcel)| LandXmlParcelProbeJs {
                source_id: &parcel.source_id,
                probe,
            })
            .collect(),
        resolved_monuments: plan
            .monuments
            .iter()
            .map(|monument| {
                Ok(LandXmlResolvedMonumentJs {
                    source_id: &monument.source_id,
                    point: match (&monument.point, &monument.pnt_ref) {
                        (Some(point), _) => Some(*point),
                        (None, Some(reference)) => resolver.resolve(
                            monument.point_scope_id.as_ref(),
                            &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
                                pnt_ref: reference.clone(),
                            },
                        )?,
                        (None, None) => None,
                    },
                })
            })
            .collect::<Result<Vec<_>, ifc_lite_landxml::LandXmlError>>()?,
        resolved_geometry: resolved_geometry(plan, &mut resolver)?,
    })
}
