// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The style each produced mesh's colour came from (#10698), paired with the
//! mesh from the colour decision to the finish join.
//!
//! `MeshData` and `RawInstanceOccurrence` keep their public fields, so the
//! source travels beside them: inside production as [`ProducedMesh`] /
//! [`ProducedOccurrence`] records (a source is created with its mesh and moves
//! with it), and out of [`produce_element_meshes_owned_styled`] as
//! [`StyledElementMeshes`], whose source lists follow the published meshes and
//! occurrences one for one.
//!
//! [`produce_element_meshes_owned_styled`]: super::produce_element_meshes_owned_styled

use super::{MeshData, ProducedElementMeshes, RawInstanceOccurrence};

/// Where a produced mesh's colour came from: what an authored finish
/// (roughness, metallic) is joined by. A mesh takes the finish of the styled
/// item its colour came from, never of another style with the same colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StyleSource {
    /// The styled item (an `IfcStyledItem` target) whose style decided the
    /// colour: the geometry item itself, the mapped geometry reached through
    /// it, the `IfcMappedItem` occurrence it was produced under, a type's
    /// representation map, or, for a part that fell back to the element
    /// colour, the item that colour came from. A palette split of a part keeps
    /// the part's source, and so does a class's fixed display colour.
    Style(u32),
    /// The colour came from no style: a material colour or a type default.
    Unstyled,
    /// The colour was supplied by the caller (an element colour passed as RGBA
    /// alone), so where it came from is not known. No style is inferred from
    /// the colour, and no finish is joined.
    Unavailable,
}

impl StyleSource {
    /// The styled item, if the colour came from one.
    pub fn style(self) -> Option<u32> {
        match self {
            Self::Style(id) => Some(id),
            Self::Unstyled | Self::Unavailable => None,
        }
    }
}

/// A produced mesh and the source of its colour.
pub(crate) struct ProducedMesh {
    pub(crate) mesh: MeshData,
    pub(crate) style: StyleSource,
}

/// A don't-bake instance occurrence and the source of its colour.
pub(crate) struct ProducedOccurrence {
    pub(crate) occurrence: RawInstanceOccurrence,
    pub(crate) style: StyleSource,
}

/// One element's production with each mesh and occurrence still paired with
/// its colour's source. `rest` holds every other output field; its `meshes`
/// and `instance_occurrences` are empty until [`Self::into_produced`].
pub(crate) struct StyledProduction {
    pub(crate) meshes: Vec<ProducedMesh>,
    pub(crate) occurrences: Vec<ProducedOccurrence>,
    pub(crate) rest: ProducedElementMeshes,
}

impl StyledProduction {
    pub(crate) fn unstyled(produced: ProducedElementMeshes) -> Self {
        let ProducedElementMeshes { meshes, instance_occurrences, .. } = &produced;
        debug_assert!(meshes.is_empty() && instance_occurrences.is_empty(), "only an empty output has no sources");
        Self { meshes: Vec::new(), occurrences: Vec::new(), rest: produced }
    }

    /// The public output: the meshes and occurrences in order, sources dropped.
    pub(crate) fn into_produced(self) -> ProducedElementMeshes {
        self.split().0
    }

    /// The public output and the sources, one per mesh and one per occurrence,
    /// in the same order.
    pub(crate) fn split(self) -> (ProducedElementMeshes, Vec<StyleSource>, Vec<StyleSource>) {
        let Self { meshes, occurrences, mut rest } = self;
        let (meshes, mesh_styles) = meshes.into_iter().map(|m| (m.mesh, m.style)).unzip();
        let (occurrences, occurrence_styles) = occurrences.into_iter().map(|o| (o.occurrence, o.style)).unzip();
        rest.meshes = meshes;
        rest.instance_occurrences = occurrences;
        (rest, mesh_styles, occurrence_styles)
    }
}

/// [`ProducedElementMeshes`] with the [`StyleSource`] of every mesh and every
/// instance occurrence, from [`produce_element_meshes_owned_styled`].
///
/// [`produce_element_meshes_owned_styled`]: super::produce_element_meshes_owned_styled
#[non_exhaustive]
pub struct StyledElementMeshes {
    production: StyledProduction,
}

impl StyledElementMeshes {
    pub(crate) fn new(production: StyledProduction) -> Self {
        Self { production }
    }

    /// The output, with one source per mesh (`meshes[i]` ↔ `mesh_styles[i]`)
    /// and one per instance occurrence (`instance_occurrences[i]` ↔
    /// `occurrence_styles[i]`): same lengths, same order.
    pub fn into_parts(self) -> (ProducedElementMeshes, Vec<StyleSource>, Vec<StyleSource>) {
        self.production.split()
    }
}

#[cfg(test)]
#[path = "styled_output_tests.rs"]
mod tests;
