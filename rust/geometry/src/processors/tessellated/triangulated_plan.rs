// SPDX-License-Identifier: MPL-2.0
//! Owned explicit triangle construction before winding and flat-shaded expansion.
//! Coordinates preserve the production fast reader's f32 precision. RTC, when
//! supplied in file length units, is subtracted in f64 before that narrowing.
//! Without RTC these are raw file-unit coordinates; unit scaling and product/
//! mapping placement remain router responsibilities. Authored Normals remain
//! unused by this production policy: each emitted triangle receives its own
//! geometric face normal, including on replay after the decoder is disposed.
use super::polygonal::PolygonalFaceSetProcessor;
use crate::{Error, Mesh, ResolvedTextureMap, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};

type OrientedTriangles = (Vec<f32>, Vec<u32>, bool, Option<Vec<u32>>);

#[derive(Debug, Clone)]
pub(crate) struct TriangulatedFaceSetPlan {
    positions: Vec<f32>,
    coord_index: Vec<u32>,
    pn_index: Option<Vec<u32>>,
    orient_outward: bool,
    rtc_applied: bool,
}

/// Decode through the existing raw-byte coordinate/index fast paths. This owns
/// construction arrays, not an expanded or already evaluated triangle Mesh.
/// Source admission and its refusal counters stay attached to the decoder.
pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<TriangulatedFaceSetPlan> {
    let coordinates = entity
        .attr(slot::IfcTriangulatedFaceSet::COORDINATES)
        .ok_or_else(|| Error::geometry("TriangulatedFaceSet missing Coordinates".to_string()))?;
    let coordinates = coordinates
        .as_entity_ref()
        .ok_or_else(|| Error::geometry("Expected entity reference for Coordinates".to_string()))?;
    let positions = super::read_point_list(decoder, coordinates, rtc_file_units)?;
    let coord_index = super::indices::read_triangle_coord_index(entity, decoder)?;
    let pn_index =
        super::indices::read_pn_index(entity, slot::IfcTriangulatedFaceSet::PN_INDEX.index());
    let orient_outward = super::orients_outward(entity.attr(slot::IfcTriangulatedFaceSet::CLOSED));
    Ok(TriangulatedFaceSetPlan {
        positions,
        coord_index,
        pn_index,
        orient_outward,
        rtc_applied: rtc_file_units.is_some(),
    })
}

impl TriangulatedFaceSetPlan {
    /// Consume decoded arrays without cloning them on the ordinary load path.
    /// A retained caller can clone the owned construction to replay it.
    pub(crate) fn evaluate(self) -> Mesh {
        let rtc_applied = self.rtc_applied;
        let (positions, indices, _, _) = self.oriented();
        let mut mesh = PolygonalFaceSetProcessor::build_flat_shaded_mesh(&positions, &indices);
        mesh.validate_indices();
        mesh.rtc_applied = rtc_applied;
        mesh
    }

    /// Presentation evaluation shares the same winding/PnIndex construction.
    /// UV indexing remains authored-coordinate indexing when no explicit
    /// TexCoordIndex exists; remapped point IDs never substitute for UV IDs.
    pub(crate) fn evaluate_with_texture(self, map: &ResolvedTextureMap) -> (Mesh, Vec<f32>) {
        self.evaluate_with_uvs(&map.tex_coords, map.tex_coord_index.clone())
    }

    /// Canonical numerical UV evaluation from an owned reached snapshot.
    pub(crate) fn evaluate_with_uvs(self, tex_coords: &[[f32; 2]],
        authored_texture_indices: Option<Vec<[u32; 3]>>) -> (Mesh, Vec<f32>) {
        let rtc_applied = self.rtc_applied;
        let (positions, indices, flipped, authored) = self.oriented();
        let tex_coord_index = match authored_texture_indices {
            Some(mut index) => {
                if flipped {
                    for triangle in &mut index {
                        triangle.swap(1, 2);
                    }
                }
                index
            }
            None => authored
                .as_deref()
                .unwrap_or(&indices)
                .chunks_exact(3)
                .map(|triangle| {
                    [triangle[0], triangle[1], triangle[2]].map(|index| index.saturating_add(1))
                })
                .collect(),
        };
        let (mut mesh, uvs) = PolygonalFaceSetProcessor::build_flat_shaded_mesh_with_uvs(
            &positions,
            &indices,
            tex_coords,
            &tex_coord_index,
        );
        mesh.validate_indices();
        mesh.rtc_applied = rtc_applied;
        (mesh, uvs)
    }

    fn oriented(self) -> OrientedTriangles {
        let mut indices = self.coord_index;
        let mut authored = None;
        if let Some(pn_index) = self.pn_index {
            let remapped = indices
                .iter()
                .map(|&corner| super::indices::through_pn_index(corner, Some(&pn_index)))
                .collect();
            authored = Some(std::mem::replace(&mut indices, remapped));
        }
        let flipped = self.orient_outward
            && PolygonalFaceSetProcessor::orient_closed_shell_outward(
                &self.positions,
                &mut indices,
            );
        if flipped {
            for triangle in authored
                .iter_mut()
                .flat_map(|indices| indices.chunks_exact_mut(3))
            {
                triangle.swap(1, 2);
            }
        }
        (self.positions, indices, flipped, authored)
    }
}

#[cfg(test)]
#[path = "triangulated_plan_tests.rs"]
mod tests;
