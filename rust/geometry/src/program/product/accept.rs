// SPDX-License-Identifier: MPL-2.0
//! Accept-side reduction of the product walk: each validated reply moves the
//! walk to its next step, in the historical representation and item order.
use super::merged::Prepared;
use super::{texture, Action, Body, ProductControl, ProductOutput, ProductReply, Role, Sink};
use crate::program::inner_cache::CacheControl;
use crate::program::mapping::{MappingControl, MappingOutput, Reached};
use crate::representation::Select;
use crate::router::frame_parts::single_frame_source;
use crate::{Error, GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, IfcType};

impl<'a> ProductControl<'a> {
    /// Accept a validated reply. Child replies are forwarded to the child,
    /// which completes in place; every other reply consumes its action.
    pub(in crate::program) fn accept(&mut self, reply: ProductReply, router: &GeometryRouter) {
        let next = match reply {
            ProductReply::Cache(reply) => match &mut self.action {
                Action::Cache { item, control, raw } => {
                    control.accept(item, reply, router);
                    let Some(result) = control.take_result() else { return };
                    let (id, raw) = (item.id, *raw);
                    self.mesh_done(result, id, raw)
                }
                // A styled plain item records its drops, as the styled mapping
                // walk's root does.
                Action::StyledCache { item, control } => {
                    {
                        let _policy = router.enter_unsupported_policy(true);
                        control.accept(item, reply, router);
                    }
                    let Some(result) = control.take_result() else { return };
                    let Action::StyledCache { item, .. } = std::mem::replace(&mut self.action, Action::Taken) else {
                        return;
                    };
                    self.styled_item_done(&item, result, router)
                }
                _ => return,
            },
            ProductReply::Mapping(reply) => {
                let Action::Mapping { control, role } = &mut self.action else { return };
                control.accept(reply, router);
                let Some(result) = control.take_result() else { return };
                let role = *role;
                self.mapping_done(result, role)
            }
            reply => {
                let action = std::mem::replace(&mut self.action, Action::Taken);
                self.step(action, reply, router)
            }
        };
        self.action = next;
    }

    fn step(&mut self, action: Action<'a>, reply: ProductReply, router: &GeometryRouter) -> Action<'a> {
        match (action, reply) {
            (Action::Alignment, ProductReply::Alignment(Some(mesh))) => {
                self.body = Body::Prepared(Prepared::Alignment(mesh));
                Action::Placement
            }
            (Action::Alignment, ProductReply::Alignment(None)) => Action::Shape,
            (Action::Shape, ProductReply::Shape(Ok(Some(shape)))) => {
                self.direct = shape.direct_geometry(self.element, Select::Meshed);
                self.shape = Some(shape);
                self.advance()
            }
            // No geometry: the merged walk is one empty part, the styled walk
            // an empty collection; neither is placed.
            (Action::Shape, ProductReply::Shape(Ok(None))) => Action::Complete(Ok(match self.styled {
                None => ProductOutput::Parts(vec![Mesh::new()]),
                Some(_) => ProductOutput::Styled(SubMeshCollection::new()),
            })),
            (Action::Items(index), ProductReply::Items(Ok(items))) => {
                let rep = self.shape.as_ref().and_then(|shape| shape.representations().get(index));
                self.fill_only = rep.is_some_and(|rep| {
                    crate::router::annotation::is_fill_only_representation(self.element, rep)
                });
                self.items = items.into_iter();
                self.advance()
            }
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

    /// The next item of the current representation, or the next selected
    /// representation, or the finish once every one is walked.
    fn advance(&mut self) -> Action<'a> {
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
    fn child(&mut self, item: DecodedEntity, offset: Option<(f64, f64, f64)>, router: &GeometryRouter)
        -> Action<'a> {
        let mapped = item.ifc_type == IfcType::IfcMappedItem;
        match (offset, self.styled) {
            (Some(_), _) if mapped => {
                let id = item.id;
                Action::Mapping { control: MappingControl::occurrence(Reached::Nested(item)), role: Role::Single(id) }
            }
            (Some(offset), _) => Action::Cache { item, control: CacheControl::new(offset), raw: true },
            (None, None) if mapped => Action::Mapping { control: MappingControl::occurrence(Reached::Nested(item)), role: Role::Parts },
            (None, None) => Action::Cache { item, control: CacheControl::new(router.rtc_offset()), raw: false },
            (None, Some(styled)) if !mapped && !styled.textures.is_some_and(|index| index.contains_key(&item.id)) => {
                Action::StyledCache { item, control: CacheControl::new(router.rtc_offset()) }
            }
            // Per-item sub-meshes, following MappedItem references through the
            // styled mapping walk; `allow_instancing` enables the #1623
            // don't-bake decision at the top-level item.
            (None, Some(styled)) => match std::mem::replace(&mut self.body, Body::Empty) {
                Body::Sink(Sink::Styled(meshes)) => {
                    let control = MappingControl::styled(
                        Reached::Nested(item), meshes, styled.allow_instancing, styled.textures, router.rtc_offset());
                    Action::Mapping { control, role: Role::Styled }
                }
                _ => Action::Complete(Err(protocol("styled accumulator"))),
            },
        }
    }

    /// One item's mesh: merged in order, or kept under the item's own id. A
    /// raw styled item keeps only a non-empty mesh.
    fn mesh_done(&mut self, result: Result<Mesh>, id: u32, raw: bool) -> Action<'a> {
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
        -> Action<'a> {
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

    fn mapping_done(&mut self, result: Result<MappingOutput>, role: Role) -> Action<'a> {
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
fn fill_refused<'a>(error: Error, router: &GeometryRouter) -> Action<'a> {
    router.record_unsupported_item(IfcType::IfcAnnotationFillArea);
    Action::Complete(Err(error))
}

fn protocol(what: &str) -> Error {
    Error::geometry(format!("product program protocol: {what}"))
}
