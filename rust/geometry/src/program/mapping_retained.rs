// SPDX-License-Identifier: MPL-2.0
//! Retained values use the common mapping walk; no mesh cache or mesh fallback.
// On the default wasm engine every retained state is uninhabited, so the
// bodies below are statically unreachable there; they stay compiled, not shipped.
#![cfg_attr(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")),
    allow(unreachable_code, unused_variables, unused_mut))]
use super::*;
use crate::program::retained::failure::FailureSite;
use crate::program::inner::retained_program::RetainedProgramError;
#[path = "mapping_directions.rs"]
mod directions;
#[path = "mapping_validation.rs"]
mod validation;
use crate::program::retained::{LogicalRetainedValue, RetainedPlacementStage, RetainedPlanOperation, RetainedSelection, RetainedPresentation};

pub(super) struct State {
    pub(super) selection: RetainedSelection,
    levels: Vec<Vec<LogicalRetainedValue>>,
    styled: bool,
    pending_binding: Option<RetainedPresentation>,
    bindings: Vec<Option<RetainedPresentation>>,
}
impl<'a> MappingControl<'a> {
    // Admission-only numerical observer; absent from every production build.
    #[cfg(all(test, any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
    pub(in crate::program) fn admit_target_directions_for_test(
        entity: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<()> {
        directions::target(entity, decoder).map_err(|error| crate::Error::geometry(error.diagnostic()))
    }

    #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
    pub(in crate::program) fn retained_occurrence(item: Reached<'a>, selection: RetainedSelection) -> Self {
        let mut control = Self::occurrence(item);
        control.retained = Some(Box::new(State { selection, levels: Vec::new(), styled: false, pending_binding: None, bindings: Vec::new() }));
        control
    }
    #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
    pub(in crate::program) fn select_retained_styled(&mut self, allow_instancing: bool, textures: Textures<'a>) {
        self.textures = textures;
        self.allow_instancing = allow_instancing;
        if let Some(state) = &mut self.retained { state.styled = true; }
    }
    pub(super) fn check_retained_path(&self, id: u32) -> Result<()> {
        let Some(state) = &self.retained else { return Err(crate::Error::geometry("missing retained walk")) };
        let mut path = Vec::new();
        crate::resource::reserve_headers(&mut path, self.levels.len())?.retain();
        path.extend(self.levels.iter().filter(|level| !matches!(level.sink, Sink::TypeMap)).map(|level| level.item_id));
        state.selection.enter(id, &path)
    }
    pub(super) fn open_retained_level(&mut self) -> Result<()> {
        if let Some(state) = &mut self.retained {
            let state = &mut **state; // disjoint field borrows through the slot
            crate::resource::reserve_headers(&mut self.levels, 1)?.retain();
            crate::resource::reserve_headers(&mut state.levels, 1)?.retain();
            crate::resource::reserve_headers(&mut state.bindings, 1)?.retain();
            state.levels.push(Vec::new());
            state.bindings.push(state.pending_binding.take());
        }
        Ok(())
    }
    pub(in crate::program) fn retained_ready(&self) -> bool {
        crate::program::retained::ENABLED && matches!(&self.action, Action::Child(_, ChildControl::Item(c)) if c.retained_ready())
            || (self.retained.is_some() && matches!(&self.action, Action::Place(Place { parts: Placing::Retained(_), .. }) | Action::TypeFinish(_)))
    }
    pub(in crate::program) fn admit_retained(&mut self)
        -> std::result::Result<(MappingReply, Vec<RetainedPlanOperation>), RetainedProgramError> {
        if let Action::Child(_, ChildControl::Item(control)) = &mut self.action {
            return control.admit_retained().map(|(reply, operations)| (MappingReply::Child(reply), operations));
        }
        self.admit_retained_affine()
    }
    pub(super) fn admit_retained_mapping(&mut self, item: &DecodedEntity, router: &GeometryRouter,
        decoder: &mut EntityDecoder) -> MappingReply {
        let Some(state) = &self.retained else {
            return MappingReply::Entered { item_id: item.id, value: Err(crate::Error::geometry("missing retained selection")) };
        };
        let admitted = (|| {
            if self.levels.is_empty() { state.selection.enter(item.id, &[])?; }
            validation::occurrence(item, decoder)
                .map_err(|error| error.into_common(&state.selection))?;
            // Reuse source and transform admission, explicitly disabling the
            // exact instancing/cache paths. Validate every target even on hits.
            let source = router.admit_styled_occurrence(item,
                state.styled && self.allow_instancing && self.levels.is_empty(), self.textures, decoder)?;
            if let Some(transform) = &source.transform {
                super::super::retained::validate_affine(transform).map_err(|reason|
                    reason.into_common(&state.selection.failure_handle(), FailureSite::MappingPlacement, Some(item.id)))?;
            }
            let cached = state.selection.cached(decoder, router, source.source_id)?;
            Ok::<_, crate::Error>((source, cached))
        })();
        let selection = state.selection.clone();
        let styled = state.styled;
        let binding = admitted.as_ref().ok().filter(|_| styled).map(|(source, cached)| {
            // Logical source cache publication is transactional and private to
            // this execution. It never claims an exact renderer template.
            RetainedPresentation::occurrence(item.id, source.source_id, source.solid_id,
                source.solid_id.is_none() || cached.is_none())
        });
        match admitted {
            Err(error) => MappingReply::Entered { item_id: item.id, value: Err(error) },
            Ok((source, Some(values))) => MappingReply::RetainedCached(Place {
                parts: Placing::Retained(Box::new((values, selection, binding))),
                item_id: item.id, source_id: source.source_id, transform: source.transform, truncated: false,
            }),
            Ok((source, None)) => {
                if let Some(state) = &mut self.retained { state.pending_binding = binding; }
                let value = GeometryRouter::styled_source_items(&source.representation, decoder).map(|items|
                    (source.source_id, MappedOccurrence::Source {
                        representation: source.representation, items, transform: source.transform,
                    }));
                MappingReply::Entered { item_id: item.id, value }
            }
        }
    }
    pub(super) fn finish_retained_level(&mut self) -> std::result::Result<MappingReply, ProgramError> {
        let values = self.retained.as_mut().and_then(|state| state.levels.last_mut())
            .ok_or(ProgramError::StaleRequest)?;
        Ok(MappingReply::RetainedFinished(Ok(std::mem::take(values))))
    }
    pub(super) fn place_retained_mapping(item_id: u32, source_id: u32, transform: Option<Matrix4<f64>>,
        (mut values, selection, binding): (Vec<LogicalRetainedValue>, RetainedSelection, Option<RetainedPresentation>)) -> MappingReply {
        let value = (|| {
            let transform = transform.unwrap_or_else(Matrix4::identity);
            for value in &mut values {
                value.place_in_place(&transform, selection.program(), RetainedPlacementStage::Mapping { source_id })
                    .map_err(|error| error.into_common(&selection.failure_handle(), FailureSite::MappingPlacement, Some(item_id)))?;
                if let Some(binding) = &binding { value.present(binding.clone())?; }
            }
            Ok(values)
        })();
        MappingReply::RetainedPlaced { item_id, value }
    }
    pub(super) fn accept_retained_reply(&self, reply: &MappingReply) -> bool {
        self.retained.is_some() && matches!(reply, MappingReply::Child(_) | MappingReply::RetainedTypeFinished(_)
            | MappingReply::RetainedCached(_) | MappingReply::RetainedFinished(_)
            | MappingReply::RetainedPlaced { .. })
    }
    pub(super) fn accept_retained(&mut self, reply: MappingReply, router: &GeometryRouter) {
        match reply {
            MappingReply::RetainedTypeFinished(value) => {
                self.levels.pop();
                if let Some(state) = &mut self.retained { state.levels.pop(); state.bindings.pop(); }
                self.action = Action::Complete(value.map(MappingOutput::Retained));
            }
            MappingReply::Child(step) => {
                let Action::Child(item, ChildControl::Item(control)) = &mut self.action else { return };
                let id = item.item().id;
                control.accept(step, router);
                let Some(value) = control.take_retained() else { return };
                let value = value.and_then(|mut value| {
                    if self.retained.as_ref().is_some_and(|state| state.styled) {
                        value.present(RetainedPresentation::item(id, router,
                            self.textures.and_then(|textures| textures.get(&id)))?)?;
                    }
                    let mut values = Vec::new();
                    crate::resource::reserve_headers(&mut values, 1)?.retain();
                    values.push(value);
                    Ok(values)
                });
                self.append_retained(value, router);
            }
            MappingReply::RetainedCached(place) => self.action = Action::Place(place),
            MappingReply::RetainedFinished(value) => {
                let Some(level) = self.levels.pop() else { return };
                let Some(state) = &mut self.retained else { return };
                state.levels.pop();
                let binding = state.bindings.pop().flatten();
                let value = value.and_then(|values| {
                    state.selection.publish(level.source_id, &values)?;
                    Ok(values)
                });
                self.action = match value {
                    Ok(values) => Action::Place(Place {
                        parts: Placing::Retained(Box::new((values, state.selection.clone(), binding))),
                        item_id: level.item_id, source_id: level.source_id, transform: level.transform, truncated: false,
                    }),
                    Err(error) => Action::Complete(Err(error)),
                };
            }
            MappingReply::RetainedPlaced { item_id, value } => {
                // Identity belongs to the already validated common reply. The
                // explicit active levels choose the destination, never this id.
                let _ = item_id;
                self.append_retained(value, router);
            }
            _ => {}
        }
    }
    fn append_retained(&mut self, value: Result<Vec<LogicalRetainedValue>>, router: &GeometryRouter) {
        let Some(state) = &mut self.retained else { return };
        let value = value.and_then(|values| {
            if let Some(parent) = state.levels.last_mut() {
                crate::resource::reserve_headers(parent, values.len())?.retain();
                parent.extend(values);
                Ok(None)
            } else { Ok(Some(values)) }
        });
        match value {
            Ok(Some(values)) => self.action = Action::Complete(Ok(MappingOutput::Retained(values))),
            Ok(None) => {
                self.action = Action::Taken;
                self.reduce(Event::Advance, router);
            }
            Err(error) => self.action = Action::Complete(Err(error)),
        }
    }
}

impl<'a> MappingControl<'a> {
    pub(in crate::program) fn retained_type_map(rep_map: DecodedEntity, textures: Textures<'a>,
        selection: RetainedSelection) -> Self {
        let mut control = Self::new(Walk::TypeMap, Action::EnterTypeMap);
        control.rep_map = Some(Reached::Nested(rep_map));
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { control.retained = Some(Box::new(State { selection, levels: Vec::new(), styled: true,
            pending_binding: None, bindings: Vec::new() })); }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = &mut control; match selection {} }
        control.textures = textures;
        control
    }
    pub(in crate::program) fn retained_selection(&self) -> Option<&RetainedSelection> {
        self.retained.as_ref().map(|state| &state.selection)
    }
    pub(in crate::program) fn representation_map_id(&self) -> Option<u32> {
        self.rep_map.as_ref().map(|map| map.item().id)
    }
    pub(super) fn retained_type_origin(&self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> MappingReply {
        let value = (|| {
            let map = self.rep_map.as_ref().map(Reached::item)
                .ok_or_else(|| crate::Error::geometry("retained type-map root missing"))?;
            let selection = self.retained_selection()
                .ok_or_else(|| crate::Error::geometry("missing retained selection"))?;
            validation::late_origin(map, decoder)
                .map_err(|error| error.into_common(selection))?;
            router.type_map_origin(map,decoder)
        })();
        MappingReply::Origin(value)
    }
    pub(super) fn finish_retained_type_map(&mut self, origin: Option<Matrix4<f64>>)
        -> std::result::Result<MappingReply, ProgramError> {
        let id = self.representation_map_id().ok_or(ProgramError::StaleRequest)?;
        let state = &mut **self.retained.as_mut().ok_or(ProgramError::StaleRequest)?;
        let output = state.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
        let value = (|| {
            let origin = origin.unwrap_or_else(Matrix4::identity);
            super::super::retained::validate_affine(&origin).map_err(|reason|
                reason.into_common(&state.selection.failure_handle(), FailureSite::TypeMapPlacement, Some(id)))?;
            super::super::retained::proper_rigid(&origin).map_err(|reason|
                reason.into_common(&state.selection.failure_handle(), FailureSite::TypeMapPlacement, Some(id)))?;
            let mut values = std::mem::take(output);
            for value in &mut values {
                value.place_in_place(&origin,state.selection.program(),
                    RetainedPlacementStage::TypeMap { representation_map: id })
                    .map_err(|error| error.into_common(&state.selection.failure_handle(), FailureSite::TypeMapPlacement, Some(id)))?;
            }
            Ok(values)
        })();
        Ok(MappingReply::RetainedTypeFinished(value))
    }
}

impl MappingControl<'_> {
    pub(super) fn validate_retained_map(map: &DecodedEntity, decoder: &mut EntityDecoder,
        selection: &RetainedSelection) -> Result<()> {
        validation::map(map, decoder).map_err(|error| error.into_common(selection))
    }
}
