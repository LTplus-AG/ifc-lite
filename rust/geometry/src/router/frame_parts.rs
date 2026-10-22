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
use super::transforms::{ObjectPlacement, LARGE_MAPPED_ORIGIN_M};
use super::GeometryRouter;
use crate::{Error, Mesh, Result};

/// Whether `Mesh::merge` may rebase a mesh framed at `b` into one framed at `a`
/// without pushing its f32 positions past the mapped-origin precision limit.
///
/// Written as a negated `>=` so a NaN origin (already-broken input) keeps the
/// historical merge instead of opening a new part.
pub(crate) fn frames_mergeable(a: [f64; 3], b: [f64; 3]) -> bool {
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
pub(crate) fn single_frame_source(entity: &str, id: u32, mut parts: Vec<Mesh>) -> Result<Mesh> {
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
pub(crate) fn mesh_bounds(mesh: &Mesh) -> [f32; 6] {
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

pub(crate) fn union_bounds(accumulator: &mut Option<[f32; 6]>, incoming: [f32; 6]) {
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
pub(crate) struct FrameParts {
    parts: Vec<(Mesh, Option<[f32; 6]>)>,
}

impl FrameParts {
    /// Merge a non-empty `mesh` into the first part sharing its frame, or
    /// open a new part.
    pub(crate) fn merge(&mut self, mesh: &Mesh, bounds: [f32; 6]) {
        let index = match matching_frame(self.parts.iter().map(|(part, _)| part.origin), mesh.origin) {
            Ok(index) => index,
            Err(_) => return,
        };
        match index.map(|index| &mut self.parts[index]) {
            Some((part, part_bounds)) => {
                if !merge_admitted(part, mesh) {
                    return;
                }
                union_bounds(part_bounds, bounds);
            }
            None => {
                let mut part = Mesh::new();
                if !merge_admitted(&mut part, mesh) || !reserve_part(&mut self.parts) {
                    return;
                }
                self.parts.push((part, Some(bounds)));
            }
        }
    }

    pub(crate) fn into_parts(self) -> impl Iterator<Item = (Mesh, Option<[f32; 6]>)> {
        self.parts.into_iter()
    }
}

/// The items of one mapped source (`IfcRepresentationMap`), merged the way
/// `mapped_item.rs` and `textured.rs` always merged them, except that an item
/// in a frame at least 1 km from every earlier part's opens a frame part
/// (#6446). A single-frame source, which is every source observed in the
/// fixture corpus, runs the exact historical `Mesh::merge` sequence.
#[derive(Default)]
pub(crate) struct SourceParts {
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
    pub(crate) fn merge(&mut self, mesh: &Mesh) {
        if mesh.is_empty() {
            return; // Mesh::merge would ignore it too
        }
        let index = match matching_frame(self.parts.iter().map(|part| part.mesh.origin), mesh.origin) {
            Ok(index) => index,
            Err(_) => return,
        };
        match index.map(|index| &mut self.parts[index]) {
            Some(part) => {
                if !merge_admitted(&mut part.mesh, mesh) {
                    return;
                }
                match (part.bounds, mesh.local_bounds) {
                    (Some(_), Some(incoming)) => union_bounds(&mut part.bounds, incoming),
                    _ => part.bounds = None,
                }
            }
            None => {
                let mut part = Mesh::new();
                if !merge_admitted(&mut part, mesh) || !reserve_part(&mut self.parts) {
                    return;
                }
                self.parts.push(SourcePart { mesh: part, bounds: mesh.local_bounds });
            }
        }
    }

    /// The primary accumulator (empty for an empty source) followed by any
    /// frame parts. A part keeps `local_bounds` only when every item it holds
    /// published them: an item rebased into its f64 origin does (#7690), and
    /// its positions alone would not give its object-frame extent. Ordinary
    /// items do not, so an ordinary source carries none, as it never did.
    ///
    /// Under an installed resource account a refused merge is only recorded
    /// as the account's sticky terminal stop; it surfaces here, before any
    /// partial source can be published.
    pub(crate) fn into_parts(self) -> Result<Vec<Mesh>> {
        if crate::resource::is_active() {
            crate::resource::check_current()?;
            let mut output = Vec::new();
            crate::resource::reserve_headers(&mut output, self.parts.len().max(1))?.retain();
            if self.parts.is_empty() {
                output.push(Mesh::new());
            }
            for SourcePart { mut mesh, bounds } in self.parts {
                mesh.local_bounds = bounds;
                output.push(mesh);
            }
            return Ok(output);
        }
        if self.parts.is_empty() {
            return Ok(vec![Mesh::new()]);
        }
        Ok(self
            .parts
            .into_iter()
            .map(|SourcePart { mut mesh, bounds }| {
                mesh.local_bounds = bounds;
                mesh
            })
            .collect())
    }
}

impl GeometryRouter {
    /// Finish a merged product walk: place each far part like the already
    /// placed primary part, then fold the RTC-frame (`rebased`) items into the
    /// first part sharing their placed frame, or keep them as their own part.
    /// Reads no source: `placement` was resolved once for the product.
    pub(crate) fn place_frame_parts(
        &self,
        placement: &ObjectPlacement,
        hygiene: SourceHygiene,
        primary: Mesh,
        far_parts: FrameParts,
        (mut rebased, rebased_bounds): (Mesh, Option<[f32; 6]>),
    ) -> Result<Vec<Mesh>> {
        let accounted = crate::resource::is_active();
        let mut parts = if accounted {
            crate::resource::check_current()?;
            let mut parts = Vec::new();
            crate::resource::reserve_headers(&mut parts, 1)?.retain();
            parts.push(primary);
            parts
        } else {
            vec![primary]
        };
        for (mut part, bounds) in far_parts.into_parts() {
            part.local_bounds = bounds;
            hygiene.for_router(self).apply(&mut part);
            self.place_mesh(&mut part, placement);
            if accounted {
                crate::resource::reserve_headers(&mut parts, 1)?.retain();
            }
            parts.push(part);
        }
        if rebased.positions.is_empty() {
            return Ok(parts);
        }
        hygiene.for_router(self).apply(&mut rebased);
        self.place_mesh(&mut rebased, placement);
        // Mesh::merge accounts for each mesh's f64 origin. Keep the local
        // bucket's origin so a distant raw item cannot quantize it early;
        // a raw item too far from every part stays its own part (#6349).
        let index = if accounted {
            matching_frame(parts.iter().map(|part| part.origin), rebased.origin)?
        } else {
            parts.iter().position(|p| frames_mergeable(p.origin, rebased.origin))
        };
        match index.map(|index| &mut parts[index]) {
            Some(part) => {
                if accounted {
                    crate::resource::mesh::merge_mesh(part, &rebased)?.retain();
                } else {
                    part.merge(&rebased);
                }
                if let Some(bounds) = rebased_bounds {
                    union_bounds(&mut part.local_bounds, bounds);
                }
            }
            None => {
                rebased.local_bounds = rebased_bounds;
                if accounted {
                    crate::resource::reserve_headers(&mut parts, 1)?.retain();
                }
                parts.push(rebased);
            }
        }
        Ok(parts)
    }
}

#[cfg(test)]
#[path = "frame_parts_tests.rs"]
mod tests;

/// Merge `incoming` into `target`. Without an installed account this is exactly
/// `Mesh::merge`; with one, admission precedes reserve/copy and a refusal leaves
/// `target` untouched, recorded as the account's sticky terminal stop.
pub(crate) fn merge_admitted(target: &mut Mesh, incoming: &Mesh) -> bool {
    if !crate::resource::is_active() {
        target.merge(incoming);
        return true;
    }
    match crate::resource::mesh::merge_mesh(target, incoming) {
        Ok(permit) => {
            permit.retain();
            true
        }
        Err(_) => false,
    }
}

fn reserve_part<T>(parts: &mut Vec<T>) -> bool {
    match crate::resource::reserve_headers(parts, 1) {
        Ok(permit) => {
            permit.retain();
            true
        }
        Err(_) => false,
    }
}

/// Index of the first part sharing `origin`'s frame. Under an account every
/// candidate visit is charged, so the scan is bounded; without one it is the
/// historical `position` scan.
fn matching_frame(
    origins: impl Iterator<Item = [f64; 3]>,
    origin: [f64; 3],
) -> std::result::Result<Option<usize>, crate::resource::ProgramStop> {
    if !crate::resource::is_active() {
        return Ok(origins.into_iter().position(|candidate| frames_mergeable(candidate, origin)));
    }
    for (index, candidate) in origins.enumerate() {
        crate::resource::charge(crate::resource::Cost { work: 1, ..Default::default() })?;
        if frames_mergeable(candidate, origin) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}
