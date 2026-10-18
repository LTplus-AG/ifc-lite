// SPDX-License-Identifier: MPL-2.0
//! Ordered owned surface faces before triangulation, including intentional
//! per-face skipping and terminal collection errors. RTC stays f64 until output.
use super::{read_simple_face_bounds, trace_capped_face};
use super::super::super::advanced_face::{lower_face, note_face_refused, FacePlan};
use super::super::super::helpers::FaceData;
use super::super::faceted::FacetedBrepProcessor;
use crate::{construction::ConstructionReports, Error, Mesh, Point3, Result, TessellationQuality};
use super::super::super::diagnostic_capture;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone)]
enum SurfaceFace {
    Simple { face_type: IfcType, outer: Vec<Point3<f64>>, holes: Vec<Vec<Point3<f64>>> },
    Advanced { face_id: u32, plan: FacePlan },
    RefusedAdvanced { face_id: u32, error: String },
}

#[derive(Debug, Clone)]
struct FaceEntry {
    face: Option<SurfaceFace>,
    source_reports: ConstructionReports,
}

#[derive(Debug, Clone)]
pub(crate) struct SurfaceModelPlan {
    faces: Vec<FaceEntry>,
    rtc_file_units: Option<(f64, f64, f64)>,
    // An invalid later collection must still return the original error after
    // earlier admitted faces have had their numerical refusal diagnostics.
    terminal_collection_error: Option<String>,
}

pub(super) fn lower(
    entity: &DecodedEntity, decoder: &mut EntityDecoder,
    quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>,
    names: (&str, &str), collection_slot: usize,
) -> Result<SurfaceModelPlan> {
    let (missing_attribute, collection_noun) = names;
    let collections = entity.get(collection_slot)
        .ok_or_else(|| Error::geometry(missing_attribute.to_string()))?
        .as_list().ok_or_else(|| Error::geometry(format!("Expected {collection_noun} list")))?;
    let mut plan = SurfaceModelPlan { faces: Vec::new(), rtc_file_units,
        terminal_collection_error: None };
    for collection_ref in collections {
        let Some(collection_id) = collection_ref.as_entity_ref() else {
            plan.terminal_collection_error = Some(format!("Expected entity reference for {collection_noun}"));
            break;
        };
        // Both connected face sets and shells inherit CfsFaces at position 0.
        let Some(face_ids) = decoder.get_entity_ref_list_fast(collection_id) else { continue };
        for face_id in face_ids {
            // Isolate source reports per face. Emitting all of them now would
            // place later source refusals ahead of earlier numeric refusals.
            let (face, source_reports) = diagnostic_capture::capture(||
                lower_entry(face_id, decoder, quality, rtc_file_units));
            plan.faces.push(FaceEntry { face, source_reports });
        }
    }
    Ok(plan)
}

fn lower_entry(face_id: u32, decoder: &mut EntityDecoder,
    quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>,
) -> Option<SurfaceFace> {
    let face = decoder.decode_by_id(face_id).ok()?;
    if face.ifc_type == IfcType::IfcAdvancedFace {
        return Some(match lower_face(&face, decoder, quality, rtc_file_units) {
            Ok(plan) => SurfaceFace::Advanced { face_id, plan },
            Err(error) => SurfaceFace::RefusedAdvanced { face_id, error: error.to_string() },
        });
    }
    let bound_ids = decoder.get_entity_ref_list_fast(face_id)?;
    let (outer, holes) = read_simple_face_bounds(&face.ifc_type, bound_ids, decoder)?;
    let outer = outer.filter(|points| points.len() >= 3)?;
    Some(SurfaceFace::Simple { face_type: face.ifc_type, outer, holes })
}

impl SurfaceModelPlan {
    /// Eager graph compilation can retain admission reports without emitting
    /// them on the production path before preceding numeric work has run.
    pub(crate) fn source_reports(&self) -> ConstructionReports {
        let mut reports = ConstructionReports::default();
        for entry in &self.faces { reports.merge(entry.source_reports.clone()); }
        reports
    }

    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let mut all_positions = Vec::new();
        let mut all_indices = Vec::new();
        for entry in self.faces {
            diagnostic_capture::restore(&entry.source_reports);
            let Some(face) = entry.face else { continue };
            let (positions, indices) = match face {
                SurfaceFace::Simple { face_type, outer, holes } => {
                    let face_data = FaceData { outer_points: outer, hole_points: holes };
                    let result = FacetedBrepProcessor::triangulate_face(&face_data,
                        self.rtc_file_units.unwrap_or((0.0, 0.0, 0.0)));
                    if result.refused { note_face_refused(&face_type); }
                    (result.positions, result.indices)
                }
                SurfaceFace::RefusedAdvanced { face_id, error } => {
                    trace_capped_face(face_id, &error);
                    continue;
                }
                SurfaceFace::Advanced { face_id, plan } => match plan.evaluate() {
                    Ok(result) => result,
                    Err(error) => { trace_capped_face(face_id, &error); continue; }
                },
            };
            if !positions.is_empty() {
                let base_idx = (all_positions.len() / 3) as u32;
                all_positions.extend(positions);
                for index in indices { all_indices.push(base_idx + index); }
            }
        }
        if let Some(error) = self.terminal_collection_error { return Err(Error::geometry(error)); }
        Ok(Mesh {
            positions: all_positions, normals: Vec::new(), indices: all_indices,
            rtc_applied: self.rtc_file_units.is_some(), welded_in_object_frame: false,
            plane_tags: None, origin: [0.0; 3], instance_meta: None,
            local_bounds: None, local_to_world: None,
        })
    }
}

#[cfg(test)]
#[path = "surface_model_plan_tests.rs"]
mod tests;
