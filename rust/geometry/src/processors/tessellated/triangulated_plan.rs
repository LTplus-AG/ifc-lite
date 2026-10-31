// SPDX-License-Identifier: MPL-2.0
//! Owned explicit triangle construction before winding and flat-shaded expansion.
//! Coordinates preserve the production fast reader's f32 precision. RTC, when
//! supplied in file length units, is subtracted in f64 before that narrowing.
//! Without RTC these are raw file-unit coordinates; unit scaling and product/
//! mapping placement remain router responsibilities. Authored Normals remain
//! unused by this production policy: each emitted triangle receives its own
//! geometric face normal, including on replay after the decoder is disposed.
use super::mesh_build::{authored_uv, emits_triangle};
use super::polygonal::PolygonalFaceSetProcessor;
use crate::{Error, Mesh, ResolvedTextureMap, Result};
use ifc_lite_core::{extract_coordinate_list_from_entity, slot, DecodedEntity, EntityDecoder};
use std::borrow::Cow;

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
        let tex_coords = &map.tex_coords;
        let rtc_applied = self.rtc_applied;
        let (positions, indices, flipped, authored) = self.oriented();
        let tex_coord_index = uv_index(map, flipped, authored.as_deref().unwrap_or(&indices));
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

    /// Winding-final corners into the f32 point list, with each triangle's
    /// `CoordIndex` row. Corners outside the list drop as the mesher drops them.
    #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
    pub(crate) fn source_triangles(self) -> super::SourceTriangles {
        let (positions, indices, _, _) = self.oriented();
        let rows = (0..indices.len() as u32 / 3).collect();
        super::SourceTriangles { positions, indices, rows, row_count: 0 }.keep_emitted()
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

/// The per-triangle 1-based UV rows the mesher samples. Borrow the authored
/// `TexCoordIndex` unless the shell winding was flipped; only a flip needs an
/// owned, swapped copy. `$` pairs texture vertices with the authored
/// (pre-`PnIndex`) corners.
fn uv_index<'m>(map: &'m ResolvedTextureMap, flipped: bool, authored: &[u32]) -> Cow<'m, [[u32; 3]]> {
    match &map.tex_coord_index {
        Some(index) if flipped => Cow::Owned(index.iter().map(|&[a, b, c]| [a, c, b]).collect()),
        Some(index) => Cow::Borrowed(index.as_slice()),
        None => Cow::Owned(
            authored
                .chunks_exact(3)
                .map(|triangle| [triangle[0], triangle[1], triangle[2]].map(|index| index.saturating_add(1)))
                .collect(),
        ),
    }
}

/// How many corners the textured mesher fills with `(0, 0)` for this face set
/// and map (#7955 J5 UV authority): corners of EMITTED triangles whose
/// `TexCoordIndex` row is missing or names no texture vertex. It reads the
/// same index arrays and applies the mesher's own predicates
/// ([`emits_triangle`], [`authored_uv`]), so a triangle the mesher drops for an
/// out-of-range point is not judged, and later rows are judged against the
/// triangles that really sample them. The shell-winding flip only permutes
/// corners within a triangle (in both arrays alike), so the count is taken on
/// the authored order. Positions are not read; only their count is taken, by
/// the side-effect-free raw-byte reader. `None` when that reader cannot answer
/// or an index array is unreadable: the caller then makes no claim.
pub(crate) fn fabricated_uv_corners(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    map: &ResolvedTextureMap,
) -> Option<usize> {
    let coordinates = entity.attr(slot::IfcTriangulatedFaceSet::COORDINATES)?.as_entity_ref()?;
    let vertex_count = decoder.get_raw_bytes(coordinates).and_then(extract_coordinate_list_from_entity)?.len() / 3;
    let authored = super::indices::read_triangle_coord_index(entity, decoder).ok()?;
    let pn_index = super::indices::read_pn_index(entity, slot::IfcTriangulatedFaceSet::PN_INDEX.index());
    let rows = uv_index(map, false, &authored);
    let fabricated = authored
        .chunks_exact(3)
        .enumerate()
        .filter(|(_, triangle)| {
            let corner = |i: usize| super::indices::through_pn_index(triangle[i], pn_index.as_deref()) as usize;
            emits_triangle([corner(0), corner(1), corner(2)], vertex_count)
        })
        .map(|(t, _)| (0..3).filter(|&corner| authored_uv(rows.get(t), corner, &map.tex_coords).is_none()).count())
        .sum();
    Some(fabricated)
}

#[cfg(test)]
#[path = "triangulated_plan_tests.rs"]
mod tests;
