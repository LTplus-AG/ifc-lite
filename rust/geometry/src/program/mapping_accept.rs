// SPDX-License-Identifier: MPL-2.0
//! The mapping controller's numerical merge/close steps and its accept side:
//! each validated reply is installed and the next step selected.
use super::{Action, ChildControl, Event, MappingControl, MappingOutput, MappingValue, Merged, Merging, Placeholder,
    Place, Placing, Reached, Sink, Walk};
use super::super::inner::ProgramError;
use crate::router::mapped_item::MappedOccurrence;
use crate::{Error, GeometryRouter, Result};

type Step = std::result::Result<MappingValue, ProgramError>;

impl<'a> MappingControl<'a> {
    /// Merge into the innermost accumulator. A styled walk's root plain item
    /// has no level: it is the walk's only item, kept at its own coordinates.
    pub(super) fn merge(&mut self, merging: Merging, router: &GeometryRouter) -> Step {
        let nested = !self.levels.is_empty();
        let type_map = matches!(self.levels.last(), Some(level) if matches!(level.sink, Sink::TypeMap));
        Ok(MappingValue::Merged(match merging {
            Merging::Item(mut mesh) => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                let mut parts = std::mem::take(&mut level.parts);
                router.keep_rebase_in_origin(&mut mesh);
                parts.merge(&mesh);
                Merged::Parts(parts)
            }
            Merging::Nested(nested) => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                let mut parts = std::mem::take(&mut level.parts);
                nested.iter().for_each(|part| parts.merge(part));
                Merged::Parts(parts)
            }
            Merging::Textured(id, mut mesh, uvs) => {
                let map = self.textures.and_then(|index| index.get(&id)).ok_or(ProgramError::StaleRequest)?;
                // A source item still goes through its mapping and placement,
                // so its rebase moves into its origin (#5698, #7690).
                if nested {
                    router.keep_rebase_in_origin(&mut mesh);
                }
                if type_map {
                    let mut textured = std::mem::take(&mut self.textured);
                    // UV-carrying parts are retained output: admit the header
                    // growth before the push, so a zero allowance refuses it.
                    let admitted = match crate::resource::is_active() {
                        true => crate::router::textured::admit_textured_part(&mut textured),
                        false => Ok(()),
                    };
                    Merged::Textured(admitted.map(|()| {
                        textured.push((mesh, uvs, map.attachment()));
                        textured
                    }))
                } else {
                    let mut meshes = std::mem::take(&mut self.meshes);
                    meshes.add_textured(id, mesh, uvs, map.attachment());
                    Merged::Styled(meshes)
                }
            }
            Merging::Styled(id, mut mesh) => {
                if nested {
                    router.keep_rebase_in_origin(&mut mesh);
                }
                let mut meshes = std::mem::take(&mut self.meshes);
                meshes.add(id, mesh);
                Merged::Styled(meshes)
            }
        }))
    }

    /// Close the innermost source: into frame parts, or, styled, bake its
    /// mapping into its items' sub-meshes and re-tag a don't-bake template.
    pub(super) fn finish(&mut self, router: &GeometryRouter) -> Step {
        let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
        let Sink::Styled { start, template } = &level.sink else {
            return Ok(MappingValue::Finished(std::mem::take(&mut level.parts).into_parts()));
        };
        let mut meshes = std::mem::take(&mut self.meshes);
        let produced = meshes.sub_meshes.get_mut(*start..).unwrap_or_default();
        if let Some(transform) = &level.transform {
            router.bake_styled_mapping(produced, transform);
        }
        if template.is_some() {
            GeometryRouter::retag_dont_bake_template(produced, level.source_id, level.transform.as_ref());
        }
        Ok(MappingValue::StyledFinished(meshes))
    }

    /// Place an occurrence's source-coords parts by its mapping.
    pub(super) fn place(place: Place, router: &GeometryRouter) -> MappingValue {
        let Place { parts, item_id, source_id, transform, truncated } = place;
        let value = match parts {
            Placing::Cached(mesh) => router.clone_cached_mesh(&mesh).map(|mesh| vec![mesh]),
            Placing::Walked(parts) => Ok(parts),
        };
        let value = value.map(|mut parts| {
            router.place_mapped_parts(source_id, &mut parts, transform.as_ref());
            parts
        });
        MappingValue::Placed { item_id, truncated, value }
    }

    /// Push a don't-bake occurrence's placeholder directly:
    /// `SubMeshCollection::add` drops empty meshes, and this one is
    /// intentionally empty (its InstanceMeta is the payload).
    pub(super) fn push_placeholder(&mut self, placeholder: Placeholder) -> MappingValue {
        let Placeholder { solid_id, source_id, transform } = placeholder;
        let mut meshes = std::mem::take(&mut self.meshes);
        let mesh = GeometryRouter::dont_bake_placeholder(source_id, transform.as_ref());
        meshes.sub_meshes.push(crate::SubMesh::new(solid_id, mesh));
        MappingValue::Placeholder(meshes)
    }

    pub(in crate::program) fn accept(&mut self, reply: super::MappingReply, router: &GeometryRouter) {
        self.budget = reply.budget;
        let reply = reply.value;
        if let MappingValue::Refused { item_id, refusal } = reply {
            self.stop_logical(item_id, refusal, router);
            return;
        }
        // A child step drives its control in place: the action, which holds
        // the child's whole state, moves only once the child completes.
        let reply = match (&mut self.action, reply) {
            (Action::Child(item, control), reply @ (MappingValue::Child(_) | MappingValue::CacheChild(_))) => {
                let policy = self.levels.last().is_none_or(|level| level.policy);
                let result = {
                    let _policy = router.enter_unsupported_policy(policy);
                    match (control, reply) {
                        (ChildControl::Item(control), MappingValue::Child(step)) => {
                            control.accept(step, router);
                            control.take_result()
                        }
                        (ChildControl::Cache(control), MappingValue::CacheChild(reply)) => {
                            control.accept(item.item(), reply, router);
                            control.take_result()
                        }
                        _ => None,
                    }
                };
                if let Some(result) = result {
                    self.accept_child_result(result, router);
                }
                return;
            }
            (_, reply) => reply,
        };
        let event = match (std::mem::replace(&mut self.action, Action::Taken), reply) {
            (Action::Taken, MappingValue::Entered { item_id, value }) => match value {
                Err(error) => Event::Deliver { item_id, truncated: false, value: Err(error) },
                Ok((source_id, MappedOccurrence::Cached { mesh, transform })) => {
                    let parts = Placing::Cached(mesh);
                    self.action = Action::Place(Place { parts, item_id, source_id, transform, truncated: false });
                    return;
                }
                Ok((source_id, MappedOccurrence::Source { representation, items, transform })) => {
                    self.enter_source(item_id, source_id, transform, &representation, items, Sink::Occurrence, router);
                    Event::Advance
                }
            },
            (Action::SharedItems(representation, source_id, placeholder), MappingValue::SharedItems(Ok(items))) => {
                let sink = Sink::Shared(placeholder);
                self.enter_source(u32::MAX, source_id, None, representation.item(), items, sink, router);
                Event::Advance
            }
            (Action::SharedItems(representation, ..), MappingValue::SharedItems(Err(error))) => {
                Event::Deliver { item_id: representation.item().id, truncated: false, value: Err(error) }
            }
            (Action::Texture(item), MappingValue::Textured(built)) => match built {
                Some((mesh, uvs)) => {
                    self.action = Action::Merge(Merging::Textured(item.item().id, mesh, uvs));
                    return;
                }
                // A failed textured build falls through to the untextured paths.
                None => match self.select_plain(item, router) {
                    Some(event) => event,
                    None => return,
                },
            },
            (Action::Taken, MappingValue::Merged(merged)) => match merged {
                Merged::Styled(meshes) => {
                    self.meshes = meshes;
                    Event::Advance
                }
                Merged::Textured(Ok(textured)) => {
                    self.textured = textured;
                    Event::Advance
                }
                Merged::Textured(Err(stop)) => self.fail_level(stop, router),
                Merged::Parts(parts) => match self.levels.last_mut() {
                    Some(level) => {
                        level.parts = parts;
                        Event::Advance
                    }
                    None => return,
                },
            },
            (Action::Taken, MappingValue::Finished(value)) => match self.levels.pop() {
                Some(level) => self.finish_level(level, value, router),
                None => return,
            },
            (Action::Taken, MappingValue::Placed { item_id, truncated, value }) => {
                Event::Deliver { item_id, truncated, value }
            }
            (Action::Taken, MappingValue::StyledEntered { item_id, value }) => self.enter_styled(item_id, value, router),
            (Action::StyledItems(pending), MappingValue::StyledItems(items)) => self.open_styled(pending, items, router),
            (Action::Taken, MappingValue::StyledFinished(meshes)) => {
                self.meshes = meshes;
                self.close_styled(router)
            }
            (Action::Taken, MappingValue::Placeholder(meshes)) => {
                self.action = Action::Complete(Ok(MappingOutput::Styled(meshes)));
                return;
            }
            (Action::Taken, MappingValue::TypeMapEntered(value)) => match (value, self.rep_map) {
                (Ok((representation, items)), Some(rep_map)) => {
                    // Whether a dropped item here is a real content gap, or this
                    // router declining a 2D map it was never meant to mesh: the
                    // TYPE path selects maps by reference/instantiation only, so a
                    // Revit/ArchiCAD 'FootPrint' or 'Annotation' map reaches here
                    // carrying items no processor handles, CORRECTLY absent from a
                    // 3D view. Only the counting is gated, once per SOURCE, not
                    // the walk: see `GeometryRouter::claim_unsupported_source`.
                    self.enter_source(u32::MAX, rep_map.id, None, &representation, items, Sink::TypeMap, router);
                    Event::Advance
                }
                (Err(error), _) => Event::Deliver { item_id: u32::MAX, truncated: false, value: Err(error) },
                (Ok(_), None) => return,
            },
            (Action::Taken, MappingValue::Origin(origin)) => match origin {
                Ok(origin) => {
                    self.action = Action::TypeFinish(origin);
                    return;
                }
                Err(error) => self.fail_level(error, router),
            },
            (Action::Taken, MappingValue::TypeFinished(parts)) => {
                self.levels.pop();
                self.action = Action::Complete(parts.map(MappingOutput::Type));
                return;
            }
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (action, _) => {
                self.action = action;
                return;
            }
        };
        self.reduce(event, router);
    }

    /// A completed child: its mesh merges next, in item order; a failure is
    /// a recorded drop or fails its level.
    fn accept_child_result(&mut self, result: Result<crate::Mesh>, router: &GeometryRouter) {
        let Action::Child(item, control) = std::mem::replace(&mut self.action, Action::Taken) else { return };
        let event = match result {
            // A styled walk's root plain item is its only item, kept at its
            // own coordinates: its sub-mesh is the walk's whole output.
            Ok(mesh) if self.walk == Walk::Styled && self.levels.is_empty() => {
                self.meshes.add(item.item().id, mesh);
                self.complete(Ok(Vec::new()));
                return;
            }
            Ok(mesh) => {
                self.action = Action::Merge(match control {
                    ChildControl::Item(_) => Merging::Item(mesh),
                    ChildControl::Cache(_) => Merging::Styled(item.item().id, mesh),
                });
                return;
            }
            Err(error) => self.drop_or_fail(item.item(), error, router),
        };
        self.reduce(event, router);
    }

    /// The selected plain item of the innermost source: through the cache
    /// controller on a styled source, else its processor, if it has one.
    pub(super) fn select_plain(&mut self, item: Reached<'a>, router: &GeometryRouter) -> Option<Event> {
        let styled = match self.levels.last() {
            Some(level) => matches!(level.sink, Sink::Styled { .. }),
            None => self.walk == Walk::Styled,
        };
        if styled {
            let control = super::CacheControl::new(router.rtc_offset());
            self.action = Action::Child(item, ChildControl::Cache(control));
            return None;
        }
        if router.processor_for(&item.item().ifc_type).is_none() {
            return Some(self.drop_or_fail(item.item(), Error::geometry("no processor"), router));
        }
        let control = super::ItemControl::new(router.rtc_offset());
        self.action = Action::Child(item, ChildControl::Item(control));
        None
    }

    /// A failed plain item is a recorded drop; a program stop fails its level.
    pub(super) fn drop_or_fail(&mut self, item: &ifc_lite_core::DecodedEntity, error: Error,
        router: &GeometryRouter) -> Event {
        match self.drop_item(item, error, router) {
            Ok(()) => Event::Advance,
            Err(stop) => self.fail_level(stop, router),
        }
    }

    /// Complete the walk from a delivered root result.
    pub(super) fn complete(&mut self, value: Result<Vec<crate::Mesh>>) {
        let output = match self.walk {
            Walk::Styled => value.map(|_| MappingOutput::Styled(std::mem::take(&mut self.meshes))),
            _ => value.map(MappingOutput::Parts),
        };
        self.action = Action::Complete(output);
    }
}
