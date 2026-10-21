// SPDX-License-Identifier: MPL-2.0
//! One product's representation walk, merged into frame parts or kept as
//! per-item sub-meshes.
//!
//! The walk is owned state: the shape, a resumable cursor over its meshed
//! representations and the current representation's items. Source steps
//! admit one reached thing at a time (an `IfcAlignment` axis, the shape, one
//! representation's items, an annotation fill's rings, a raw item's element
//! frame, a textured face set, the placement); each item's geometry is its
//! canonical item/cache or mapping child; numerical steps merge an item into
//! the accumulators in item order, finish them under the requested hygiene
//! and place them. Router effects (dropped-item records) apply at accept.
use super::inner::{ProgramError, ProgramStage};
use super::inner_cache::{CacheControl, CacheReply};
use super::mapping::{MappingControl, MappingReply};
use crate::processors::texture::ResolvedTextureMap;
use crate::representation::{product_shape, rep_items, ProductShape};
use crate::router::annotation::{admit_fill, AnnotationRings};
use crate::router::processing::SourceHygiene;
use crate::router::transforms::ObjectPlacement;
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

mod accept;
mod merged;
use merged::{Merged, Prepared};

type Textures<'a> = Option<&'a FxHashMap<u32, ResolvedTextureMap>>;

/// What the walk's items feed.
enum Sink {
    Merged(Merged),
    Styled(SubMeshCollection),
}

/// The walk's geometry: its accumulators, then the finished geometry
/// awaiting placement. Numerical steps work on it in place, so neither a
/// step nor its reply carries a second copy of the accumulators.
enum Body {
    Sink(Sink),
    Prepared(Prepared),
    /// Lent to a styled mapping child, or consumed.
    Empty,
}

/// A completed product walk's output.
pub(super) enum ProductOutput {
    Parts(Vec<Mesh>),
    Styled(SubMeshCollection),
}

/// What a mapping child's output becomes.
#[derive(Clone, Copy)]
enum Role {
    /// A merged mapped item's frame parts (#6446).
    Parts,
    /// A raw mapped item meshed in its element frame: one mesh (#5698).
    Single(u32),
    /// A styled item's sub-meshes, appended to the walk's collection.
    Styled,
}

enum Action<'a> {
    /// Read an `IfcAlignment`'s axis through the alignment processor.
    Alignment,
    /// Resolve the product's `IfcProductDefinitionShape`.
    Shape,
    /// Resolve one selected representation's items.
    Items(usize),
    /// Read an annotation fill's style and boundary rings.
    Annotation(DecodedEntity),
    /// Triangulate an annotation fill read by the previous step.
    AnnotationMesh(u32, AnnotationRings),
    /// Decide whether a raw-coordinate item rebases in its element frame.
    Raw(DecodedEntity),
    /// Build a textured face set with its UVs (#1781).
    Texture(DecodedEntity),
    /// One item through the content-dedup and hash caches; `raw` when it is
    /// meshed in its element frame.
    Cache { item: DecodedEntity, control: CacheControl, raw: bool },
    /// A styled walk's plain item: no mapping to walk, so it runs the cache
    /// controller in place and lands in the sub-meshes under its own id.
    StyledCache { item: DecodedEntity, control: CacheControl },
    /// One item through the mapping controller.
    Mapping { control: MappingControl<'a>, role: Role },
    /// Merge an item's meshes into the accumulators, in item order.
    Merge(Vec<Mesh>),
    /// Close the accumulators under the requested hygiene.
    Finish,
    /// Resolve the product's placement.
    Placement,
    /// Place the finished geometry.
    Place(ObjectPlacement),
    Complete(Result<ProductOutput>),
    /// Moved out by an executing or accepting step.
    Taken,
}

pub(super) enum ProductReply {
    Alignment(Option<Mesh>),
    Shape(Result<Option<ProductShape>>),
    Items(Result<Vec<DecodedEntity>>),
    Annotation(Result<AnnotationRings>),
    AnnotationMesh(u32, Result<Mesh>),
    Raw(Result<Option<(f64, f64, f64)>>),
    Texture(Result<Option<(Mesh, Vec<f32>)>>),
    Cache(CacheReply),
    Mapping(MappingReply),
    Merged(bool),
    Finished(Result<()>),
    Placement(Result<ObjectPlacement>),
    Placed(Result<ProductOutput>),
}

impl ProductReply {
    pub(super) fn tag(&self) -> u8 {
        match self {
            Self::Alignment(_) => 0,
            Self::Shape(_) => 1,
            Self::Items(_) => 2,
            Self::Annotation(_) => 3,
            Self::AnnotationMesh(..) => 4,
            Self::Raw(_) => 5,
            Self::Texture(_) => 6,
            Self::Merged(_) => 7,
            Self::Finished(_) => 8,
            Self::Placement(_) => 9,
            Self::Placed(_) => 10,
            Self::Cache(reply) => 16 + reply.tag(),
            Self::Mapping(reply) => 32 + reply.tag(),
        }
    }
}

/// The styled walk's per-item policy.
#[derive(Clone, Copy)]
struct Styled<'a> {
    allow_instancing: bool,
    textures: Textures<'a>,
}

pub(super) struct ProductControl<'a> {
    element: &'a DecodedEntity,
    hygiene: SourceHygiene,
    /// `None` for the merged walk.
    styled: Option<Styled<'a>>,
    shape: Option<ProductShape>,
    /// Whether the shape carries direct body geometry (read once).
    direct: bool,
    /// The next representation index the cursor examines.
    next_rep: usize,
    items: std::vec::IntoIter<DecodedEntity>,
    fill_only: bool,
    body: Body,
    action: Action<'a>,
}

impl<'a> ProductControl<'a> {
    fn new(element: &'a DecodedEntity, hygiene: SourceHygiene, styled: Option<Styled<'a>>) -> Self {
        let sink = match styled {
            None => Sink::Merged(Merged::default()),
            Some(_) => Sink::Styled(SubMeshCollection::new()),
        };
        // IfcAlignment carries its directrix curve in a dedicated `Axis`
        // attribute (IFC4X1) instead of (or in addition to) a normal
        // IfcShapeRepresentation, and its Representation is often `$`: the
        // merged walk tries the alignment processor first.
        let action = if styled.is_none() && element.ifc_type == IfcType::IfcAlignment {
            Action::Alignment
        } else {
            Action::Shape
        };
        Self {
            element,
            hygiene,
            styled,
            shape: None,
            direct: false,
            next_rep: 0,
            items: Vec::new().into_iter(),
            fill_only: false,
            body: Body::Sink(sink),
            action,
        }
    }

    /// The merged walk: body items combined into frame parts (#6349).
    pub(super) fn merged(element: &'a DecodedEntity, hygiene: SourceHygiene) -> Self {
        Self::new(element, hygiene, None)
    }

    /// The styled walk: one sub-mesh per item, under its geometry id.
    pub(super) fn styled(element: &'a DecodedEntity, allow_instancing: bool, textures: Textures<'a>,
        hygiene: SourceHygiene) -> Self {
        Self::new(element, hygiene, Some(Styled { allow_instancing, textures }))
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match &self.action {
            // The alignment processor's own source-and-mesh callback.
            Action::Alignment => Some(ProgramStage::Extension),
            Action::Shape | Action::Items(_) | Action::Annotation(_) | Action::Raw(_)
            | Action::Texture(_) | Action::Placement => Some(ProgramStage::Source),
            Action::Cache { control, .. } | Action::StyledCache { control, .. } => return control.stage(),
            Action::Mapping { control, .. } => return control.stage(),
            Action::AnnotationMesh(..) | Action::Merge(_) | Action::Finish | Action::Place(_) => {
                Some(ProgramStage::Numerical)
            }
            Action::Complete(_) => None,
            Action::Taken => return Err(ProgramError::Outstanding),
        })
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<ProductReply, ProgramError> {
        // Source steps keep their action in place: the accept consumes it.
        let (element, styled) = (self.element, self.styled);
        match &mut self.action {
            Action::Alignment => return Ok(ProductReply::Alignment(router.alignment_mesh(element, decoder))),
            Action::Shape => {
                return Ok(ProductReply::Shape(product_shape(element, decoder).map_err(Into::into)));
            }
            Action::Items(index) => {
                let rep = self.shape.as_ref().and_then(|shape| shape.representations().get(*index));
                let rep = rep.ok_or(ProgramError::StaleRequest)?;
                return Ok(ProductReply::Items(rep_items(rep, decoder).map_err(Into::into)));
            }
            Action::Annotation(item) => return Ok(ProductReply::Annotation(admit_fill(item, decoder))),
            Action::Raw(item) => {
                return Ok(ProductReply::Raw(router.raw_item_element_offset(item, element, decoder)));
            }
            Action::Texture(item) => {
                let map = texture(styled, item).ok_or(ProgramError::StaleRequest)?;
                let textured = router.element_frame_rtc(element, decoder)
                    .map(|offset| router.textured_face_set(item, decoder, map, offset));
                return Ok(ProductReply::Texture(textured));
            }
            Action::Cache { item, control, .. } | Action::StyledCache { item, control } => {
                return control.execute(item, router, decoder).map(ProductReply::Cache);
            }
            Action::Mapping { control, .. } => return control.execute(router, decoder).map(ProductReply::Mapping),
            Action::Placement => {
                return Ok(ProductReply::Placement(router.resolve_object_placement(element, decoder)));
            }
            _ => {}
        }
        Ok(match std::mem::replace(&mut self.action, Action::Taken) {
            Action::AnnotationMesh(id, rings) => ProductReply::AnnotationMesh(id, rings.evaluate(router.unit_scale())),
            Action::Merge(parts) => match &mut self.body {
                Body::Sink(Sink::Merged(merged)) => ProductReply::Merged(merged.merge(parts)),
                _ => return Err(ProgramError::StaleRequest),
            },
            Action::Finish => match std::mem::replace(&mut self.body, Body::Empty) {
                Body::Sink(sink) => ProductReply::Finished(merged::finish(sink, self.hygiene.for_router(router))
                    .map(|prepared| self.body = Body::Prepared(prepared))),
                _ => return Err(ProgramError::StaleRequest),
            },
            Action::Place(placement) => match std::mem::replace(&mut self.body, Body::Empty) {
                Body::Prepared(prepared) => ProductReply::Placed(prepared.place(&placement, router)),
                _ => return Err(ProgramError::StaleRequest),
            },
            other => {
                self.action = other;
                return Err(ProgramError::StaleRequest);
            }
        })
    }

    pub(super) fn take_result(&mut self) -> Option<Result<ProductOutput>> {
        match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Complete(result) => Some(result),
            other => {
                self.action = other;
                None
            }
        }
    }
}

/// The texture a styled item is built with (#1781): a face set listed in the
/// walk's index. A terrain TIN is a face set that only appends `Flags` (#5942).
fn texture<'a>(styled: Option<Styled<'a>>, item: &DecodedEntity) -> Option<&'a ResolvedTextureMap> {
    let textures = styled?.textures?;
    textures.get(&item.id).filter(|_| matches!(
        item.ifc_type,
        IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork
    ))
}
