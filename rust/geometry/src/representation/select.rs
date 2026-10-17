// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which of a product's representations a caller means: the single canonical
//! definition of which `IfcShapeRepresentation`s carry renderable body geometry
//! ([`Select::Meshed`]) and the other questions asked of the same list.

use ifc_lite_core::{DecodedEntity, IfcType};

/// Whether an `IfcShapeRepresentation.RepresentationType` names a meshable
/// body/surface (as opposed to a curve/axis/annotation/footprint/box). This is
/// the SINGLE canonical definition of "renderable 3D geometry", shared by the
/// element meshing path (`processing.rs`), the void probe (opening extraction),
/// RTC-offset detection, and material-layer slicing so every site agrees on what
/// counts as real geometry. Drift here is a bug: an element meshed as body but
/// judged non-body by RTC detection casts a spurious origin vote (see
/// `rtc_offset::sample_element_translation`).
///
/// `MappedRepresentation` is included (its `IfcMappedItem`s expand to real
/// solids); callers that specifically mean DIRECT (non-mapped) geometry use
/// [`is_direct_body_representation`] instead.
pub(crate) fn is_body_representation(rep_type: &str) -> bool {
    matches!(
        rep_type,
        "Body"
            | "SweptSolid"
            | "Brep"
            | "CSG"
            | "Clipping"
            | "Tessellation"
            | "MappedRepresentation"
            | "SolidModel"
            | "SurfaceModel"
            | "Surface3D"
            | "AdvancedSweptSolid"
            | "AdvancedBrep"
    )
}

/// Whether a `RepresentationType` names DIRECT (non-mapped) body geometry, i.e.
/// [`is_body_representation`] minus the `MappedRepresentation` sentinel. Used to
/// decide whether an element's `MappedRepresentation` duplicates geometry it
/// already carries directly (and so can be skipped to avoid double-meshing).
pub(crate) fn is_direct_body_representation(rep_type: &str) -> bool {
    rep_type != "MappedRepresentation" && is_body_representation(rep_type)
}

/// Whether a near-origin element with this `RepresentationType` may cast a
/// "no-shift" `(0,0,0)` RTC vote when the vertex probe can't cheaply read a
/// coordinate. This is [`is_body_representation`] MINUS `"Surface3D"` —
/// meshable does NOT imply RTC-votable.
///
/// A `Surface3D` rep (`IfcBSplineSurfaceWithKnots`, `IfcSectionedSurface`,
/// trimmed/curve-bounded surfaces) keeps its geometry in absolute model-space
/// control points that the RTC vertex probe cannot navigate, so a near-origin
/// identity-placed Surface3D element would fall through to voting its placement
/// `(0,0,0)` even though its real geometry can sit on a national grid hundreds
/// of km away. On IFC4X3 corridor models with many such surfaces ahead of a few
/// large-coordinate solids, those origin votes drag the median to zero and/or
/// exhaust the 50-sample budget, suppressing a legitimate rebase — the #1526
/// curve-only pollution rebuilt via Surface3D. So Surface3D must ABSTAIN here,
/// like a curve/axis rep. Scoped to RTC voting only: the meshing / void / layer
/// paths still treat Surface3D as body geometry.
pub(crate) fn is_rtc_votable_representation(rep_type: &str) -> bool {
    rep_type != "Surface3D" && is_body_representation(rep_type)
}

/// The string that should drive body-representation filtering for an
/// `IfcShapeRepresentation`: `RepresentationType` (attribute 2) when present
/// and non-blank, else the `RepresentationIdentifier` (attribute 1).
///
/// CATIA exports write `IFCSHAPEREPRESENTATION(#ctx,'Body','',(items))` —
/// the TYPE is an empty string while the IDENTIFIER carries 'Body'. Filtering
/// on the raw type alone vetoes the whole representation and the element
/// meshes to zero triangles (issue #1661: both reported walls). A `$` (null)
/// type never reached the filter, so only the empty-string spelling was
/// affected.
pub(crate) fn effective_rep_type(shape_rep: &DecodedEntity) -> Option<&str> {
    [2usize, 1].into_iter().find_map(|idx| {
        shape_rep
            .get(idx)
            .and_then(|a| a.as_string())
            .filter(|s| !s.trim().is_empty())
    })
}

/// Opening Reference geometry describes an existing hole, never a cutter.
/// Keep ordinary products' rendering convention unchanged; only opening
/// semantics override the otherwise type-first representation predicate (#4433).
pub(crate) fn effective_element_rep_type<'a>(element: &DecodedEntity, shape_rep: &'a DecodedEntity) -> Option<&'a str> {
    if element.ifc_type.is_subtype_of(IfcType::IfcOpeningElement)
        && shape_rep.get_string(1).is_some_and(|id| id.eq_ignore_ascii_case("Reference")) {
        return Some("Reference");
    }
    effective_rep_type(shape_rep)
}

/// Which of a product's representations a caller means. The variants are the
/// distinct questions the router asks of one `Representations` list; each is a
/// filter over the same list, in list order.
#[non_exhaustive]
#[derive(Clone, Copy)]
pub enum Select {
    /// What the mesh path renders ([`meshed_representations`]): the one
    /// definition of "what renders".
    Meshed,
    /// `IfcShapeRepresentation`s whose effective type is body geometry, with no
    /// mapped-duplicate exclusion (material-layer slicing).
    Body,
    /// What may cast an RTC vote: `IfcShapeRepresentation`s of an
    /// RTC-votable body type, plus a structural `Face` topology representation.
    RtcVotable,
    /// Every representation.
    Any,
    /// A caller predicate over `(element, representation, effective type)`.
    Where(fn(&DecodedEntity, &DecodedEntity, Option<&str>) -> bool),
}

impl Select {
    /// Whether `rep` of `element` is selected. `has_direct_geometry` is
    /// [`has_direct_geometry`] of the whole list, read only by `Meshed`.
    pub(super) fn admits(
        self,
        element: &DecodedEntity,
        rep: &DecodedEntity,
        has_direct_geometry: bool,
    ) -> bool {
        match self {
            Select::Meshed => meshed_admits(element, rep, has_direct_geometry),
            Select::Body => {
                rep.ifc_type == IfcType::IfcShapeRepresentation
                    && effective_element_rep_type(element, rep)
                        .is_some_and(is_body_representation)
            }
            Select::RtcVotable => effective_element_rep_type(element, rep).is_some_and(|rep_type| {
                (rep.ifc_type == IfcType::IfcShapeRepresentation
                    && is_rtc_votable_representation(rep_type))
                    || (rep.ifc_type == IfcType::IfcTopologyRepresentation
                        && rep_type == "Face"
                        && crate::router::structural::accepts(element, rep_type))
            }),
            Select::Any => true,
            Select::Where(keep) => keep(element, rep, effective_element_rep_type(element, rep)),
        }
    }

    /// Whether `has_direct_geometry` must be computed for this policy.
    pub(super) fn needs_direct_geometry(self) -> bool {
        matches!(self, Select::Meshed)
    }
}

/// Whether the list carries direct (non-mapped) body geometry, which makes a
/// `MappedRepresentation` of the same element a duplicate.
pub(super) fn has_direct_geometry(element: &DecodedEntity, representations: &[DecodedEntity]) -> bool {
    representations
        .iter()
        .filter(|rep| rep.ifc_type == IfcType::IfcShapeRepresentation)
        .any(|rep| {
            effective_element_rep_type(element, rep).is_some_and(is_direct_body_representation)
        })
}

fn meshed_admits(element: &DecodedEntity, rep: &DecodedEntity, has_direct_geometry: bool) -> bool {
    // A structural curve member's edge geometry lives on an
    // `IfcTopologyRepresentation`, not an `IfcShapeRepresentation` — a
    // different entity type entirely, though both are `IfcRepresentation`
    // subtypes sharing the same `ContextOfItems`/`RepresentationIdentifier`/
    // `RepresentationType`/`Items` attribute layout, so `effective_rep_type`
    // reads it the same way. Gated on `structural::accepts` so this doesn't
    // open `IfcTopologyRepresentation` up generally (e.g. the fixture's
    // `'Vertex'`-typed ones on `IfcStructuralPointConnection`, out of scope
    // here — see `structural::accepts`'s doc comment).
    let is_meshable_rep = rep.ifc_type == IfcType::IfcShapeRepresentation
        || (rep.ifc_type == IfcType::IfcTopologyRepresentation
            && effective_rep_type(rep)
                .is_some_and(|rt| crate::router::structural::accepts(element, rt)));
    is_meshable_rep
        && effective_element_rep_type(element, rep).is_none_or(|rep_type| {
            !(rep_type == "MappedRepresentation" && has_direct_geometry)
                && (is_body_representation(rep_type)
                    || crate::router::annotation::accepts(element, rep_type)
                    || crate::router::structural::accepts(element, rep_type))
        })
}

/// The representations of `element` (its `IfcProductDefinitionShape`
/// `Representations`, decoded) that the element meshing paths mesh, in order:
/// each `IfcShapeRepresentation` whose effective type is body geometry, or an
/// annotation's 2D fill, or that names no type at all, minus a
/// `MappedRepresentation` when the element also carries direct body geometry.
/// Anything that must agree with what renders (the `IgnoreOpaque` opening
/// filter in `ifc-lite-processing`, #4699) selects through this.
pub fn meshed_representations<'a>(
    element: &'a DecodedEntity,
    representations: &'a [DecodedEntity],
) -> impl Iterator<Item = &'a DecodedEntity> + 'a {
    let direct = has_direct_geometry(element, representations);
    representations.iter().filter(move |rep| meshed_admits(element, rep, direct))
}
