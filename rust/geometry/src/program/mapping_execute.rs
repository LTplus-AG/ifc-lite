// SPDX-License-Identifier: MPL-2.0
//! Source transactions carry their logical debits to validated acceptance.
use super::*;
use crate::program::mapping_budget::{LogicalBudget, SourceFailure, SourceResult};
use ifc_lite_core::EntityDecoder;

pub(in crate::program) struct MappingReply {
    pub(super) value: MappingValue,
    pub(super) budget: LogicalBudget,
}
impl MappingReply {
    pub(in crate::program) fn tag(&self) -> u8 { self.value.tag() }
}

fn source_reply<T>(result: SourceResult<T>, item_id: u32,
    reply: impl FnOnce(Result<T>) -> MappingValue) -> MappingValue {
    match result {
        Ok(value) => reply(Ok(value)),
        Err(SourceFailure::Content(error)) => reply(Err(error)),
        Err(SourceFailure::Budget(refusal)) => MappingValue::Refused { item_id, refusal },
    }
}

impl MappingControl<'_> {
    pub(in crate::program) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<MappingReply, ProgramError> {
        let mut budget = self.budget;
        // Nested path/depth checks have already selected this action. A root
        // attempt pays too, including an eventual cache hit or placeholder.
        if let Action::Enter(item) | Action::EnterStyled(item) = &self.action {
            if let Err(refusal) = budget.mapped_attempt() {
                return Ok(MappingReply {
                    value: MappingValue::Refused { item_id: item.item().id, refusal }, budget,
                });
            }
        }
        let value = self.execute_step(router, decoder, &mut budget)?;
        Ok(MappingReply { value, budget })
    }

    fn execute_step(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder, budget: &mut LogicalBudget)
        -> std::result::Result<MappingValue, ProgramError> {
        // Steps that keep their action in place: the accept consumes it.
        match &mut self.action {
            Action::Child(item, ChildControl::Item(control)) => {
                return control.execute(item.item(), router, decoder).map(MappingValue::Child);
            }
            Action::Child(item, ChildControl::Cache(control)) => {
                return control.execute(item.item(), router, decoder).map(MappingValue::CacheChild);
            }
            Action::SharedItems(representation, ..) => {
                return Ok(source_reply(GeometryRouter::shared_source_items(representation.item(), decoder, budget),
                    representation.item().id, MappingValue::SharedItems));
            }
            Action::StyledItems(pending) => {
                let items = GeometryRouter::styled_source_items(&pending.representation, decoder, budget);
                return Ok(source_reply(items, pending.item_id, MappingValue::StyledItems));
            }
            Action::Texture(item) => {
                let item = item.item();
                let map = self.textures.and_then(|index| index.get(&item.id)).ok_or(ProgramError::StaleRequest)?;
                return Ok(MappingValue::Textured(router.textured_face_set(item, decoder, map, Some(router.rtc_offset()))));
            }
            _ => {}
        }
        Ok(match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Enter(entering) => {
                let item = entering.item();
                let value = router.admit_mapped_occurrence(item, decoder, budget);
                source_reply(value, item.id, |value| MappingValue::Entered { item_id: item.id, value })
            }
            Action::EnterStyled(entering) => {
                let item = entering.item();
                // Only the top-level occurrence is independent: a nested map is
                // part of its parent's shared geometry, never don't-baked.
                // Eligibility decodes at most one member. This is the root's
                // first action: Items usage is zero, and mapped_attempt above
                // proved limit >= 1. No additional debit or meter is needed.
                let eligible = self.allow_instancing && self.levels.is_empty();
                let value = router.admit_styled_occurrence(item, eligible, self.textures, decoder);
                MappingValue::StyledEntered { item_id: item.id, value }
            }
            Action::EnterTypeMap => {
                let rep_map = self.rep_map.ok_or(ProgramError::StaleRequest)?;
                source_reply(router.admit_type_map(rep_map, decoder, budget), rep_map.id, MappingValue::TypeMapEntered)
            }
            Action::Origin => {
                let rep_map = self.rep_map.ok_or(ProgramError::StaleRequest)?;
                MappingValue::Origin(router.type_map_origin(rep_map, decoder))
            }
            Action::TypeFinish(origin) => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                let parts = std::mem::take(&mut level.parts);
                let textured = std::mem::take(&mut self.textured);
                MappingValue::TypeFinished(router.finish_type_map(parts, textured, origin.as_ref()))
            }
            Action::Merge(merging) => self.merge(merging, router)?,
            Action::Finish => self.finish(router)?,
            Action::Place(place) => Self::place(place, router),
            Action::Placeholder(placeholder) => self.push_placeholder(placeholder),
            other => {
                self.action = other;
                return Err(ProgramError::StaleRequest);
            }
        })
    }

}
