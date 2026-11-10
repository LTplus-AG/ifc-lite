// SPDX-License-Identifier: MPL-2.0
//! Source transactions carry their logical debits to validated acceptance.
use super::*;
use crate::program::mapping_budget::{LogicalBudget, SourceFailure, SourceResult};
use ifc_lite_core::EntityDecoder;

// Only source replies carry a speculative debit. Numerical/child replies do
// not copy a large enum into and out of a second, budget-bearing envelope.
pub(in crate::program) type MappingReply = MappingValue;

pub(super) fn source_reply<T>(
    result: SourceResult<T>,
    item_id: u32,
    budget: LogicalBudget,
    reply: impl FnOnce(Result<T>, LogicalBudget) -> MappingValue,
) -> MappingValue {
    match result {
        Ok(value) => reply(Ok(value), budget),
        Err(SourceFailure::Content(error)) => reply(Err(error), budget),
        Err(SourceFailure::Budget(refusal)) => MappingValue::Refused {
            item_id,
            refusal,
            budget,
        },
    }
}

impl MappingControl<'_> {
    #[inline(always)]
    fn source_reply<T>(result: SourceResult<T>, item_id: u32, budget: LogicalBudget,
        reply: impl FnOnce(Result<T>, LogicalBudget) -> MappingValue,
    ) -> std::result::Result<MappingReply, MappingFailure> {
        match result {
            Ok(value) => Ok(reply(Ok(value), budget)),
            Err(SourceFailure::Content(error)) => Ok(reply(Err(error), budget)),
            Err(SourceFailure::Budget(refusal)) => Err(MappingFailure::refused(item_id, refusal, budget)),
        }
    }

    pub(in crate::program) fn execute(
        &mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> std::result::Result<MappingReply, MappingFailure> {
        self.budget.commit(); // the accepted state's first reads (#9102)
        let mut budget = self.budget.clone();
        // Steps that keep their action in place: the accept consumes it.
        match &mut self.action {
            Action::Child(item, ChildControl::Item(control)) => {
                return control
                    .execute(item.item(), router, decoder)
                    .map(MappingValue::Child).map_err(Into::into);
            }
            Action::Child(item, ChildControl::Cache(control)) => {
                return control
                    .execute(item.item(), router, decoder)
                    .map(MappingValue::CacheChild).map_err(Into::into);
            }
            Action::SharedItems(representation, ..) => {
                let item_id = representation.item().id;
                let items = GeometryRouter::shared_source_items(representation.item(), decoder, &mut budget);
                return Self::source_reply(items, item_id, budget, MappingValue::SharedItems);
            }
            Action::StyledItems(pending) => {
                let item_id = pending.item_id;
                let items = GeometryRouter::styled_source_items(
                    &pending.representation, decoder, &mut budget,
                );
                return Self::source_reply(items, item_id, budget, MappingValue::StyledItems);
            }
            Action::Texture(item) => {
                let item = item.item();
                let map = self
                    .textures
                    .and_then(|index| index.get(&item.id))
                    .ok_or(ProgramError::StaleRequest)?;
                return Ok(MappingValue::Textured(router.textured_face_set(
                    item,
                    decoder,
                    map,
                    Some(router.rtc_offset()),
                )));
            }
            Action::Enter(item) | Action::EnterStyled(item) => {
                // A root attempt pays too, including cache hits/placeholders.
                // A refused attempt leaves its action intact until acceptance.
                if let Err(refusal) = budget.mapped_attempt() {
                    let item_id = item.item().id;
                    return Err(MappingFailure::refused(item_id, refusal, budget));
                }
            }
            _ => {}
        }
        Ok(match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Enter(entering) => {
                let item = entering.item();
                if self.retained.is_some() {
                    return Ok(self.admit_retained_mapping(item, router, decoder, &mut budget));
                }
                let value = router.admit_mapped_occurrence(item, decoder, &mut budget);
                return Self::source_reply(value, item.id, budget, |value, budget| MappingValue::Entered {
                    budget, item_id: item.id, value,
                });
            }
            Action::EnterStyled(entering) => {
                let item = entering.item();
                // Only root occurrences are independently instanced. Eligibility
                // reads at most one member: Items usage is zero here, and the
                // attempt above proved limit >= 1, so no second debit is needed.
                let eligible = self.allow_instancing && self.levels.is_empty();
                let value = router.admit_styled_occurrence(item, eligible, self.textures, decoder);
                MappingValue::StyledEntered {
                    budget,
                    item_id: item.id,
                    value,
                }
            }
            Action::EnterTypeMap => {
                let rep_map = self
                    .rep_map
                    .as_ref()
                    .map(TypeMapRoot::item)
                    .ok_or(ProgramError::StaleRequest)?;
                let item_id = rep_map.id;
                let result = if let Some(state) = &self.retained {
                    Self::validate_retained_map(rep_map, decoder, &state.selection, &mut budget)
                } else {
                    router.admit_type_map(rep_map, decoder, &mut budget)
                };
                return Self::source_reply(result, item_id, budget, MappingValue::TypeMapEntered);
            }
            Action::Origin => {
                if self.retained.is_some() {
                    return Ok(self.retained_type_origin(router, decoder));
                }
                let rep_map = self
                    .rep_map
                    .as_ref()
                    .map(TypeMapRoot::item)
                    .ok_or(ProgramError::StaleRequest)?;
                MappingValue::Origin(router.type_map_origin(rep_map, decoder))
            }
            Action::TypeFinish(origin) => {
                if self.retained.is_some() {
                    return self.finish_retained_type_map(origin).map_err(Into::into);
                }
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
                return Err(ProgramError::StaleRequest.into());
            }
        })
    }
}
