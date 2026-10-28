// SPDX-License-Identifier: MPL-2.0
//! The product walk's synchronous driver: every step applied in place.
use super::{merged, Action, Body, Child, ProductControl, Sink};
use crate::program::inner::ProgramError;
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;

impl ProductControl<'_> {
    /// Run the walk to completion against one router and decoder: the
    /// synchronous driver. Each step is the one `request`, `execute` and
    /// `accept` take, applied in place: a step's value goes straight to its
    /// acceptance, never through a reply that the walk would then move.
    pub(in crate::program) fn run(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<(), ProgramError> {
        let element = self.element;
        // Keep validation at the source/publication arms themselves, avoiding
        // a second action dispatch for every numerical and transfer step.
        macro_rules! validate_plan {
            () => {
                if let Some(plan) = &self.plan {
                    if let Err(error) = plan.validate(router, decoder) {
                        self.action = Action::Complete(Err(error));
                        return Ok(());
                    }
                }
            };
        }
        loop {
            let next = match &mut self.action {
                Action::Item { .. } => return Err(ProgramError::UnsupportedRetained),
                Action::Complete(_) => {
                    validate_plan!();
                    return Ok(());
                },
                Action::Taken => return Err(ProgramError::Outstanding),
                Action::Shape => match self.admit(router, decoder) {
                    Ok(shape) => self.shape_done(shape, router),
                    Err(error) => Action::Complete(Err(error)),
                },
                Action::Items(index) => {
                    let index = *index;
                    let (_, items) = self
                        .plan
                        .as_mut()
                        .and_then(|plan| plan.representations.get_mut(index))
                        .ok_or(ProgramError::StaleRequest)?;
                    let items = std::mem::take(items);
                    self.items_done(index, items)
                }
                Action::Raw(item) => {
                    validate_plan!();
                    let offset = router.raw_item_element_offset(item, element, decoder);
                    let Action::Raw(item) = std::mem::replace(&mut self.action, Action::Taken) else {
                        return Err(ProgramError::StaleRequest);
                    };
                    match offset {
                        Ok(offset) => self.child(item, offset, router),
                        Err(error) => Action::Complete(Err(error)),
                    }
                }
                Action::Cache { item, .. } => {
                    let Child::Cache(control) = &mut self.child else { return Err(ProgramError::StaleRequest) };
                    while control.stage()?.is_some() {
                        let reply = control.execute(item, router, decoder)?;
                        control.accept(item, reply, router);
                    }
                    self.cache_done(router).ok_or(ProgramError::Outstanding)?
                }
                Action::StyledCache { item } => {
                    let Child::Cache(control) = &mut self.child else { return Err(ProgramError::StaleRequest) };
                    while control.stage()?.is_some() {
                        let reply = control.execute(item, router, decoder)?;
                        let _policy = router.enter_unsupported_policy(true);
                        control.accept(item, reply, router);
                    }
                    self.cache_done(router).ok_or(ProgramError::Outstanding)?
                }
                Action::Mapping { .. } => {
                    let Child::Mapping(control) = &mut self.child else { return Err(ProgramError::StaleRequest) };
                    while control.stage()?.is_some() {
                        let reply = control.execute(router, decoder)?;
                        control.accept(reply, router);
                    }
                    self.mapping_next().ok_or(ProgramError::Outstanding)?
                }
                Action::Merge(_) => {
                    let Action::Merge(parts) = std::mem::replace(&mut self.action, Action::Taken) else {
                        return Err(ProgramError::StaleRequest);
                    };
                    let Body::Sink(Sink::Merged(merged)) = &mut self.body else {
                        return Err(ProgramError::StaleRequest);
                    };
                    if merged.merge(parts) { self.advance() } else { Action::Finish }
                }
                Action::Finish => {
                    let Body::Sink(sink) = std::mem::replace(&mut self.body, Body::Empty) else {
                        return Err(ProgramError::StaleRequest);
                    };
                    match merged::finish(sink, self.hygiene.for_router(router)) {
                        Ok(prepared) => {
                            self.body = Body::Prepared(Box::new(prepared));
                            Action::Placement
                        }
                        Err(error) => Action::Complete(Err(error)),
                    }
                }
                Action::Placement => {
                    validate_plan!();
                    match router.resolve_object_placement(element, decoder) {
                        Ok(placement) => Action::Place(placement),
                        Err(error) => Action::Complete(Err(error)),
                    }
                },
                Action::Place(_) => {
                    let Action::Place(placement) = std::mem::replace(&mut self.action, Action::Taken) else {
                        return Err(ProgramError::StaleRequest);
                    };
                    let Body::Prepared(prepared) = std::mem::replace(&mut self.body, Body::Empty) else {
                        return Err(ProgramError::StaleRequest);
                    };
                    Action::Complete(prepared.place(&placement, router))
                }
                // The rare steps (an alignment axis, an annotation fill, a
                // textured face set) take the protocol's own path, which
                // validates the same plan before any source work.
                Action::Alignment | Action::Annotation(_) | Action::AnnotationMesh(..) | Action::Texture(_) => {
                    let reply = self.execute(router, decoder)?;
                    self.accept(reply, router);
                    continue;
                }
            };
            self.action = next;
        }
    }
}
