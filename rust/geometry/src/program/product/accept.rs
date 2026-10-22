// SPDX-License-Identifier: MPL-2.0
//! Accept-side reduction of the product walk: each validated reply moves the
//! walk to its next step, in the historical representation and item order.
use super::merged::Prepared;
use super::{texture, Action, Body, Child, ProductControl, ProductOutput, ProductReply, Role, Sink};
use crate::program::inner_cache::CacheControl;
use crate::program::mapping::{MappingControl, MappingOutput, Reached};
use crate::representation::{ProductShape, Select};
use crate::router::frame_parts::single_frame_source;
use crate::{Error, GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, IfcType};

impl<'a> ProductControl<'a> {
    /// Accept a validated reply. Child replies are forwarded to the child,
    /// which completes in place; every other reply consumes its action.
    pub(in crate::program) fn accept(&mut self, reply: ProductReply, router: &GeometryRouter) {
        let next = match reply {
            ProductReply::Cache(reply) => {
                let Child::Cache(control) = &mut self.child else { return };
                match &self.action {
                    Action::Cache { item, .. } => control.accept(item, reply, router),
                    // A styled plain item records its drops, as the styled mapping
                    // walk's root does.
                    Action::StyledCache { item } => {
                        let _policy = router.enter_unsupported_policy(true);
                        control.accept(item, reply, router);
                    }
                    _ => return,
                }
                let Some(next) = self.cache_done(router) else { return };
                next
            }
            ProductReply::Mapping(reply) => {
                let Child::Mapping(control) = &mut self.child else { return };
                control.accept(reply, router);
                let Some(next) = self.mapping_next() else { return };
                next
            }
            reply => {
                let action = std::mem::replace(&mut self.action, Action::Taken);
                self.step(action, reply, router)
            }
        };
        self.action = next;
    }

    /// The next action once the cache child has completed; `None` while it
    /// still has steps.
    pub(super) fn cache_done(&mut self, router: &GeometryRouter) -> Option<Action> {
        let Child::Cache(control) = &mut self.child else { return None };
        match &self.action {
            Action::Cache { item, raw } => {
                let result = control.take_result()?;
                let (id, raw) = (item.id, *raw);
                self.child = Child::None;
                Some(self.mesh_done(result, id, raw))
            }
            Action::StyledCache { .. } => {
                let result = control.take_result()?;
                self.child = Child::None;
                let Action::StyledCache { item } = std::mem::replace(&mut self.action, Action::Taken) else {
                    return None;
                };
                Some(self.styled_item_done(&item, result, router))
            }
            _ => None,
        }
    }

    /// The next action once the mapping child has completed; `None` while it
    /// still has steps.
    pub(super) fn mapping_next(&mut self) -> Option<Action> {
        let Child::Mapping(control) = &mut self.child else { return None };
        let Action::Mapping { role } = &self.action else { return None };
        let result = control.take_result()?;
        let role = *role;
        self.child = Child::None;
        Some(self.mapping_done(result, role))
    }

    fn step(&mut self, action: Action, reply: ProductReply, router: &GeometryRouter) -> Action {
        match (action, reply) {
            (Action::Alignment, ProductReply::Alignment(Some(mesh))) => {
                self.body = Body::Prepared(Box::new(Prepared::Alignment(mesh)));
                Action::Placement
            }
            (Action::Alignment, ProductReply::Alignment(None)) => Action::Shape,
            (Action::Shape, ProductReply::Shape(Ok(shape))) => self.shape_done(shape),
            (Action::Items(index), ProductReply::Items(Ok(items))) => self.items_done(index, items),
            (Action::Annotation(item), ProductReply::Annotation(reply)) => match reply {
                Ok(rings) => Action::AnnotationMesh(item.id, rings),
                Err(error) => fill_refused(error, router),
            },
            // A numerical step moved its action into the reply it executed.
            (Action::Taken, ProductReply::AnnotationMesh(id, reply)) => match reply {
                Ok(mesh) => self.mesh_done(Ok(mesh), id, false),
                Err(error) => fill_refused(error, router),
            },
            (Action::Raw(item), ProductReply::Raw(Ok(offset))) => self.child(item, offset, router),
            (Action::Texture(item), ProductReply::Texture(Ok(Some((mesh, uvs))))) => {
                match (texture(self.styled, &item), &mut self.body) {
                    (Some(map), Body::Sink(Sink::Styled(sub_meshes))) => {
                        sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                        self.advance()
                    }
                    _ => Action::Complete(Err(protocol("textured item"))),
                }
            }
            // A failed textured build falls through to the untextured paths.
            (Action::Texture(item), ProductReply::Texture(Ok(None))) => Action::Raw(item),
            (Action::Taken, ProductReply::Merged(admitted)) => {
                if admitted { self.advance() } else { Action::Finish }
            }
            (Action::Taken, ProductReply::Finished(Ok(()))) => Action::Placement,
            (Action::Placement, ProductReply::Placement(Ok(placement))) => Action::Place(placement),
            (Action::Taken, ProductReply::Placed(result)) => Action::Complete(result),
            (_, ProductReply::Shape(Err(error)) | ProductReply::Items(Err(error)) | ProductReply::Raw(Err(error))
                | ProductReply::Texture(Err(error)) | ProductReply::Finished(Err(error))
                | ProductReply::Placement(Err(error))) => Action::Complete(Err(error)),
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            _ => Action::Complete(Err(protocol("reply"))),
        }
    }

    /// The resolved shape: its first item, or an empty product.
    pub(super) fn shape_done(&mut self, shape: Option<ProductShape>) -> Action {
        let Some(shape) = shape else {
            // No geometry: the merged walk is one empty part, the styled walk
            // an empty collection; neither is placed.
            return Action::Complete(Ok(match self.styled {
                None => ProductOutput::Parts(vec![Mesh::new()]),
                Some(_) => ProductOutput::Styled(SubMeshCollection::new()),
            }));
        };
        self.direct = shape.direct_geometry(self.element, Select::Meshed);
        self.shape = Some(shape);
        self.advance()
    }

    /// One representation's resolved items.
    pub(super) fn items_done(&mut self, index: usize, items: Vec<DecodedEntity>) -> Action {
        let rep = self.shape.as_ref().and_then(|shape| shape.representations().get(index));
        self.fill_only = rep.is_some_and(|rep| {
            crate::router::annotation::is_fill_only_representation(self.element, rep)
        });
        self.items = items.into_iter();
        self.advance()
    }

    /// The next item of the current representation, or the next selected
    /// representation, or the finish once every one is walked.
    pub(super) fn advance(&mut self) -> Action {
        let is_annotation = self.element.ifc_type == IfcType::IfcAnnotation;
        for item in self.items.by_ref() {
            if is_annotation && item.ifc_type == IfcType::IfcAnnotationFillArea {
                return Action::Annotation(item);
            }
            if self.fill_only {
                continue; // symbolic annotation item, never meshed (#5389)
            }
            // A textured face set keeps its UV channel (#1781) and, like any
            // raw item, rebases in its own frame (#5698).
            if texture(self.styled, &item).is_some() {
                return Action::Texture(item);
            }
            return Action::Raw(item);
        }
        let next = self.shape.as_ref().and_then(|shape| {
            shape.next_selected(self.element, Select::Meshed, self.direct, self.next_rep)
        });
        match next {
            Some(index) => {
                self.next_rep = index + 1;
                Action::Items(index)
            }
            None => Action::Finish,
        }
    }

    /// The reached item's canonical child. A raw-coordinate item beyond the
    /// RTC threshold is meshed in its element frame (`offset`), keeping
    /// content dedup and direct-solid instancing keyed by that offset; a
    /// declined rebase is decided in the right frame too (#5684).
    pub(super) fn child(&mut self, item: DecodedEntity, offset: Option<(f64, f64, f64)>, router: &GeometryRouter)
        -> Action {
        let mapped = item.ifc_type == IfcType::IfcMappedItem;
        match (offset, self.styled) {
            (Some(_), _) if mapped => {
                let id = item.id;
                self.child = Child::Mapping(Box::new(MappingControl::occurrence(Reached::Nested(item))));
                Action::Mapping { role: Role::Single(id) }
            }
            (Some(offset), _) => {
                self.child = Child::Cache(CacheControl::new(offset));
                Action::Cache { item, raw: true }
            }
            (None, None) if mapped => {
                self.child = Child::Mapping(Box::new(MappingControl::occurrence(Reached::Nested(item))));
                Action::Mapping { role: Role::Parts }
            }
            (None, None) => {
                self.child = Child::Cache(CacheControl::new(router.rtc_offset()));
                Action::Cache { item, raw: false }
            }
            (None, Some(styled)) if !mapped && !styled.textures.is_some_and(|index| index.contains_key(&item.id)) => {
                self.child = Child::Cache(CacheControl::new(router.rtc_offset()));
                Action::StyledCache { item }
            }
            // Per-item sub-meshes, following MappedItem references through the
            // styled mapping walk; `allow_instancing` enables the #1623
            // don't-bake decision at the top-level item.
            (None, Some(styled)) => match std::mem::replace(&mut self.body, Body::Empty) {
                Body::Sink(Sink::Styled(meshes)) => {
                    let control = MappingControl::styled(
                        Reached::Nested(item), meshes, styled.allow_instancing, styled.textures, router.rtc_offset());
                    self.child = Child::Mapping(Box::new(control));
                    Action::Mapping { role: Role::Styled }
                }
                _ => Action::Complete(Err(protocol("styled accumulator"))),
            },
        }
    }

    /// One item's mesh: merged in order, or kept under the item's own id. A
    /// raw styled item keeps only a non-empty mesh.
    fn mesh_done(&mut self, result: Result<Mesh>, id: u32, raw: bool) -> Action {
        let mesh = match result {
            Ok(mesh) => mesh,
            Err(error) => return Action::Complete(Err(error)),
        };
        match &mut self.body {
            Body::Sink(Sink::Merged(_)) => Action::Merge(vec![mesh]),
            Body::Sink(Sink::Styled(sub_meshes)) => {
                if !raw || !mesh.is_empty() {
                    sub_meshes.add(id, mesh);
                }
                self.advance()
            }
            _ => Action::Complete(Err(protocol("accumulators"))),
        }
    }

    /// A styled plain item's mesh, kept under its own id; a failure is the
    /// styled walk's recorded root drop, or the program stop it carried.
    fn styled_item_done(&mut self, item: &DecodedEntity, result: Result<Mesh>, router: &GeometryRouter)
        -> Action {
        match (result, &mut self.body) {
            (Ok(mesh), Body::Sink(Sink::Styled(sub_meshes))) => {
                sub_meshes.add(item.id, mesh);
                self.advance()
            }
            (Ok(_), _) => Action::Complete(Err(protocol("styled accumulator"))),
            (Err(error), _) => match MappingControl::drop_styled_root(item, error, router) {
                Ok(()) => self.advance(),
                Err(error) => Action::Complete(Err(error)),
            },
        }
    }

    fn mapping_done(&mut self, result: Result<MappingOutput>, role: Role) -> Action {
        match (role, result) {
            (Role::Parts, Ok(MappingOutput::Parts(parts))) => match &self.body {
                Body::Sink(Sink::Merged(_)) => Action::Merge(parts),
                _ => Action::Complete(Err(protocol("merged accumulator"))),
            },
            (Role::Single(id), Ok(MappingOutput::Parts(parts))) => {
                let mesh = single_frame_source("IfcMappedItem", id, parts);
                self.mesh_done(mesh, id, true)
            }
            (Role::Styled, Ok(MappingOutput::Styled(meshes))) => {
                self.body = Body::Sink(Sink::Styled(meshes));
                self.advance()
            }
            (_, Err(error)) => Action::Complete(Err(error)),
            _ => Action::Complete(Err(protocol("mapping output"))),
        }
    }
}

/// A refused annotation fill is a recorded drop and fails the product.
fn fill_refused(error: Error, router: &GeometryRouter) -> Action {
    router.record_unsupported_item(IfcType::IfcAnnotationFillArea);
    Action::Complete(Err(error))
}

fn protocol(what: &str) -> Error {
    Error::geometry(format!("product program protocol: {what}"))
}
