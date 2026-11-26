// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A styled walk's sub-meshes paired with the `IfcMappedItem` occurrences each
//! was produced under (#10698).
//!
//! One shared item placed by two occurrences is two sub-meshes with the same
//! `geometry_id`; only the occurrence chain tells them apart, and a style on
//! an occurrence colours its own sub-mesh only. The public [`SubMesh`] and
//! [`SubMeshCollection`] stay as they are (their fields are public, so a new
//! one would break callers that build them), and the chain travels here.
//!
//! INVARIANT: a chain is a field of its sub-mesh's own [`StyledPart`]. It is
//! created with the sub-mesh and moves, is cut, dropped and rebuilt with it;
//! no code holds one without the other, so no index can fall out of step. The
//! public collection is made only by [`StyledParts::into_collection`], an
//! order-preserving 1:1 projection, the same one [`StyledSubMeshes`] exposes.

use crate::mesh::{Mesh, SubMesh, SubMeshCollection};

/// One sub-mesh and its occurrence chain.
#[derive(Debug, Clone)]
pub(crate) struct StyledPart {
    pub(crate) sub: SubMesh,
    /// The `IfcMappedItem` ids this sub-mesh was produced under, inner to
    /// outer; empty for a direct item, a layer slice or a material id.
    pub(crate) occurrences: Vec<u32>,
}

impl StyledPart {
    pub(crate) fn direct(sub: SubMesh) -> Self {
        Self { sub, occurrences: Vec::new() }
    }
}

/// The styled walk's carrier: [`SubMeshCollection`]'s rules (an empty mesh is
/// not added; `ids_are_materials` is uniform), one [`StyledPart`] per entry.
#[derive(Debug, Clone, Default)]
pub(crate) struct StyledParts {
    pub(crate) parts: Vec<StyledPart>,
    pub(crate) ids_are_materials: bool,
}

impl StyledParts {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Add a direct sub-mesh; an empty mesh is dropped, as
    /// [`SubMeshCollection::add`] drops it.
    pub(crate) fn add(&mut self, geometry_id: u32, mesh: Mesh) {
        if !mesh.is_empty() {
            self.parts.push(StyledPart::direct(SubMesh::new(geometry_id, mesh)));
        }
    }

    /// [`Self::add`] for a textured sub-mesh.
    pub(crate) fn add_textured(
        &mut self,
        geometry_id: u32,
        mesh: Mesh,
        uvs: Vec<f32>,
        texture: crate::processors::texture::TextureAttachment,
    ) {
        if !mesh.is_empty() {
            self.parts.push(StyledPart::direct(SubMesh::textured(geometry_id, mesh, uvs, texture)));
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.parts.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    /// The sub-meshes from `start` on, for an in-place pass (a bake, a
    /// placement, a weld) that changes geometry and never the chain.
    pub(crate) fn subs_mut(&mut self, start: usize) -> impl Iterator<Item = &mut SubMesh> {
        self.parts.get_mut(start..).unwrap_or_default().iter_mut().map(|part| &mut part.sub)
    }

    /// The chains from `start` on: a closing mapping level appends its own
    /// occurrence to everything produced under it.
    pub(crate) fn chains_mut(&mut self, start: usize) -> impl Iterator<Item = &mut Vec<u32>> {
        self.parts.get_mut(start..).unwrap_or_default().iter_mut().map(|part| &mut part.occurrences)
    }

    /// A don't-bake occurrence's placeholder: its mesh is intentionally empty
    /// (the instance metadata is the payload), so it bypasses [`Self::add`]'s
    /// empty-mesh drop, and its chain starts at its own occurrence `item_id`.
    pub(crate) fn push_placeholder(&mut self, sub: SubMesh, item_id: u32) {
        self.parts.push(StyledPart { sub, occurrences: vec![item_id] });
    }

    /// The public collection: each sub-mesh in order, chains dropped.
    pub(crate) fn into_collection(self) -> SubMeshCollection {
        SubMeshCollection {
            sub_meshes: self.parts.into_iter().map(|part| part.sub).collect(),
            ids_are_materials: self.ids_are_materials,
        }
    }
}

/// A styled host's parts while the openings cut them one at a time. `take`
/// lends the next part's mesh out to be cut and keeps the part itself (its id
/// and chain); `keep` puts the cut mesh back into that part. A cut rebuilds
/// vertices, so UVs and texture are dropped (#1781), and an empty cut result
/// is dropped with its part.
pub(crate) struct CutQueue {
    rest: std::vec::IntoIter<StyledPart>,
    cutting: Option<StyledPart>,
    done: StyledParts,
}

impl CutQueue {
    pub(crate) fn new(parts: StyledParts) -> Self {
        let done = StyledParts { parts: Vec::new(), ids_are_materials: parts.ids_are_materials };
        Self { rest: parts.parts.into_iter(), cutting: None, done }
    }

    pub(crate) fn take(&mut self) -> Option<(u32, Mesh)> {
        let mut part = self.rest.next()?;
        let taken = (part.sub.geometry_id, std::mem::take(&mut part.sub.mesh));
        self.cutting = Some(part);
        Some(taken)
    }

    /// `id` is the id [`Self::take`] lent the mesh out under.
    pub(crate) fn keep(&mut self, id: u32, mesh: Mesh) {
        if let Some(part) = self.cutting.take().filter(|_| !mesh.is_empty()) {
            let sub = SubMesh::new(id, mesh);
            self.done.parts.push(StyledPart { sub, occurrences: part.occurrences });
        }
    }

    pub(crate) fn into_done(self) -> StyledParts {
        self.done
    }
}

/// Layer slices and other chain-free output join the styled walk with empty
/// chains: they are produced under no `IfcMappedItem`.
impl From<SubMeshCollection> for StyledParts {
    fn from(collection: SubMeshCollection) -> Self {
        Self {
            parts: collection.sub_meshes.into_iter().map(StyledPart::direct).collect(),
            ids_are_materials: collection.ids_are_materials,
        }
    }
}

/// An element's sub-meshes, each with the `IfcMappedItem` occurrences it was
/// produced under (#10698), from the `*_styled_*` [`GeometryRouter`] entries.
///
/// The sub-meshes are exactly those the matching plain entry returns, in the
/// same order. [`Self::iter`] gives each sub-mesh with its occurrence chain:
/// the mapped items it was produced under, inner to outer: a style on one of them styles this
/// occurrence of the shared geometry, so two sub-meshes with the same
/// `geometry_id` can be coloured apart. It is empty for a direct item, a
/// material-layer slice (`ids_are_materials`) and a cut part of either.
///
/// [`GeometryRouter`]: crate::GeometryRouter
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct StyledSubMeshes {
    parts: StyledParts,
}

impl StyledSubMeshes {
    pub(crate) fn new(parts: StyledParts) -> Self {
        Self { parts }
    }

    /// Number of sub-meshes.
    pub fn len(&self) -> usize {
        self.parts.len()
    }

    /// Whether there are no sub-meshes.
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    /// Whether `SubMesh::geometry_id` is an `IfcMaterial` id rather than an
    /// `IfcRepresentationItem` id ([`SubMeshCollection::ids_are_materials`]).
    pub fn ids_are_materials(&self) -> bool {
        self.parts.ids_are_materials
    }

    /// Each sub-mesh with its occurrence chain, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&SubMesh, &[u32])> {
        self.parts.parts.iter().map(|part| (&part.sub, part.occurrences.as_slice()))
    }

    /// Each sub-mesh with its occurrence chain, in order, by value.
    pub fn into_iter_with_occurrences(self) -> impl Iterator<Item = (SubMesh, Vec<u32>)> {
        self.parts.parts.into_iter().map(|part| (part.sub, part.occurrences))
    }

    /// The plain collection the matching plain entry returns.
    pub fn into_collection(self) -> SubMeshCollection {
        self.parts.into_collection()
    }
}

#[cfg(test)]
impl crate::program::GeometryProgram<'_> {
    /// `drain_styled_parts` projected to the public collection, for tests.
    pub(crate) fn drain_styled(
        self,
        router: &crate::GeometryRouter,
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> crate::Result<SubMeshCollection> {
        self.drain_styled_parts(router, decoder).map(StyledParts::into_collection)
    }
}
