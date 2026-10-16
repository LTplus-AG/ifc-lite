// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Frame-aware item combining for the single-mesh element paths (#6349).
//!
//! `process_element` combines a product's body items into one [`Mesh`].
//! [`Mesh::merge`] rebases an item whose f64 `origin` differs from the
//! accumulator's into the accumulator's f32 positions. Since #5792 an
//! `IfcMappedItem` translated to georeferenced scale keeps that translation in
//! its f64 origin, so a near-origin direct item next to one ~5,000 km away used
//! to put the mapped vertices on a 0.5 m f32 grid. One f64 origin plus one f32
//! position array cannot hold 1e-5 m for both parts, and moving the origin only
//! moves the loss to the other part.
//!
//! So items whose frames are at least [`LARGE_MAPPED_ORIGIN_M`] apart stay in
//! separate meshes ("frame parts"), each with its own origin. Items in frames
//! closer than that merge exactly as before. An ordinary product, whose items
//! all carry a zero origin, therefore yields one part through the unchanged
//! merge sequence. Callers that must keep a single `Mesh` get an explicit error
//! from [`single_frame`] instead of silently rounded geometry.

use super::processing::SourceHygiene;
use super::transforms::LARGE_MAPPED_ORIGIN_M;
use super::GeometryRouter;
use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Whether `Mesh::merge` may rebase a mesh framed at `b` into one framed at `a`
/// without pushing its f32 positions past the mapped-origin precision limit.
///
/// Written as a negated `>=` so a NaN origin (already-broken input) keeps the
/// historical merge instead of opening a new part.
pub(super) fn frames_mergeable(a: [f64; 3], b: [f64; 3]) -> bool {
    !(0..3).any(|axis| (a[axis] - b[axis]).abs() >= LARGE_MAPPED_ORIGIN_M)
}

/// Collapse frame parts to the single mesh a legacy single-mesh API returns.
///
/// Refuses (rather than rounds) a product whose parts cannot share one frame.
pub(super) fn single_frame(element_id: u32, mut parts: Vec<Mesh>) -> Result<Mesh> {
    if parts.len() <= 1 {
        return Ok(parts.pop().unwrap_or_default());
    }
    Err(Error::geometry(format!(
        "Element #{element_id}: body items lie in {} frames up to {:.3} m apart; one f32 \
         Mesh cannot keep all of them to 1e-5 m (#6349). Use the *_parts router API.",
        parts.len(),
        frame_span(&parts)
    )))
}

/// [`single_frame`] for one mapped source (#6446): `entity` names the
/// `IfcMappedItem` or `IfcRepresentationMap` whose source items would share
/// the single mesh.
pub(super) fn single_frame_source(entity: &str, id: u32, mut parts: Vec<Mesh>) -> Result<Mesh> {
    if parts.len() <= 1 {
        return Ok(parts.pop().unwrap_or_default());
    }
    Err(Error::geometry(format!(
        "{entity} #{id}: mapped source items lie in {} frames up to {:.3} m apart; one f32 \
         Mesh cannot keep all of them to 1e-5 m (#6446). Use the *_parts router API.",
        parts.len(),
        frame_span(&parts)
    )))
}

/// Largest per-axis distance between any two part origins.
fn frame_span(parts: &[Mesh]) -> f64 {
    parts
        .iter()
        .flat_map(|part| parts.iter().map(move |other| (part.origin, other.origin)))
        .map(|(a, b)| (0..3).map(|axis| (a[axis] - b[axis]).abs()).fold(0.0, f64::max))
        .fold(0.0, f64::max)
}

/// Object-frame AABB of a mesh's f32 positions.
pub(super) fn mesh_bounds(mesh: &Mesh) -> [f32; 6] {
    let mut bounds = [
        f32::INFINITY,
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for point in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(point[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(point[axis]);
        }
    }
    bounds
}

pub(super) fn union_bounds(accumulator: &mut Option<[f32; 6]>, incoming: [f32; 6]) {
    if let Some(bounds) = accumulator {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(incoming[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(incoming[axis + 3]);
        }
    } else {
        *accumulator = Some(incoming);
    }
}

/// Items that could not join the element's primary accumulator, grouped by
/// frame. Each entry keeps the object-frame bounds of the items it holds.
#[derive(Default)]
pub(super) struct FrameParts {
    parts: Vec<(Mesh, Option<[f32; 6]>)>,
}

impl FrameParts {
    /// Merge a non-empty `mesh` into the first part sharing its frame, or
    /// open a new part.
    pub(super) fn merge(&mut self, mesh: &Mesh, bounds: [f32; 6]) {
        match self
            .parts
            .iter_mut()
            .find(|(part, _)| frames_mergeable(part.origin, mesh.origin))
        {
            Some((part, part_bounds)) => {
                part.merge(mesh);
                union_bounds(part_bounds, bounds);
            }
            None => {
                let mut part = Mesh::new();
                part.merge(mesh);
                self.parts.push((part, Some(bounds)));
            }
        }
    }

    pub(super) fn into_parts(self) -> impl Iterator<Item = (Mesh, Option<[f32; 6]>)> {
        self.parts.into_iter()
    }
}

/// The items of one mapped source (`IfcRepresentationMap`), merged the way
/// `mapped_item.rs` and `textured.rs` always merged them, except that an item
/// in a frame at least 1 km from every earlier part's opens a frame part
/// (#6446). A single-frame source, which is every source observed in the
/// fixture corpus, runs the exact historical `Mesh::merge` sequence.
#[derive(Default)]
pub(super) struct SourceParts {
    /// The primary accumulator first, then the far frame parts.
    parts: Vec<SourcePart>,
}

struct SourcePart {
    mesh: Mesh,
    /// Union of the items' object-frame `local_bounds`; `None` once any item
    /// lacked them (see [`SourceParts::into_parts`]).
    bounds: Option<[f32; 6]>,
}

impl SourceParts {
    pub(super) fn merge(&mut self, mesh: &Mesh) {
        if mesh.is_empty() {
            return; // Mesh::merge would ignore it too
        }
        match self.parts.iter_mut().find(|part| frames_mergeable(part.mesh.origin, mesh.origin)) {
            Some(part) => {
                part.mesh.merge(mesh);
                match (part.bounds, mesh.local_bounds) {
                    (Some(_), Some(incoming)) => union_bounds(&mut part.bounds, incoming),
                    _ => part.bounds = None,
                }
            }
            None => {
                let mut part = Mesh::new();
                part.merge(mesh);
                self.parts.push(SourcePart { mesh: part, bounds: mesh.local_bounds });
            }
        }
    }

    /// The primary accumulator (empty for an empty source) followed by any
    /// frame parts. A part keeps `local_bounds` only when every item it holds
    /// published them: an item rebased into its f64 origin does (#7690), and
    /// its positions alone would not give its object-frame extent. Ordinary
    /// items do not, so an ordinary source carries none, as it never did.
    pub(super) fn into_parts(self) -> Vec<Mesh> {
        if self.parts.is_empty() {
            return vec![Mesh::new()];
        }
        self.parts
            .into_iter()
            .map(|SourcePart { mut mesh, bounds }| {
                mesh.local_bounds = bounds;
                mesh
            })
            .collect()
    }
}

impl GeometryRouter {
    /// Finish `process_element_parts`: place each far part like the already
    /// placed primary part, then fold the RTC-frame (`rebased`) items into the
    /// first part sharing their placed frame, or keep them as their own part.
    pub(super) fn place_frame_parts(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        hygiene: SourceHygiene,
        primary: Mesh,
        far_parts: FrameParts,
        (mut rebased, rebased_bounds): (Mesh, Option<[f32; 6]>),
    ) -> Result<Vec<Mesh>> {
        let mut parts = vec![primary];
        for (mut part, bounds) in far_parts.into_parts() {
            part.local_bounds = bounds;
            hygiene.for_router(self).apply(&mut part);
            self.apply_placement(element, decoder, &mut part)?;
            parts.push(part);
        }
        if rebased.positions.is_empty() {
            return Ok(parts);
        }
        hygiene.for_router(self).apply(&mut rebased);
        self.apply_placement(element, decoder, &mut rebased)?;
        // Mesh::merge accounts for each mesh's f64 origin. Keep the local
        // bucket's origin so a distant raw item cannot quantize it early;
        // a raw item too far from every part stays its own part (#6349).
        match parts.iter_mut().find(|p| frames_mergeable(p.origin, rebased.origin)) {
            Some(part) => {
                part.merge(&rebased);
                if let Some(bounds) = rebased_bounds {
                    union_bounds(&mut part.local_bounds, bounds);
                }
            }
            None => {
                rebased.local_bounds = rebased_bounds;
                parts.push(rebased);
            }
        }
        Ok(parts)
    }
}

#[cfg(test)]
#[path = "frame_parts_tests.rs"]
mod tests;
