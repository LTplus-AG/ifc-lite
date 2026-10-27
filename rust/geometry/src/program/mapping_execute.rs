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
    reply: impl FnOnce(Result<T>) -> MappingValue,
) -> MappingValue {
    match result {
        Ok(value) => reply(Ok(value)),
        Err(SourceFailure::Content(error)) => reply(Err(error)),
        Err(SourceFailure::Budget(refusal)) => MappingValue::Refused {
            item_id,
            refusal,
            budget,
        },
    }
}

impl MappingControl<'_> {
    pub(in crate::program) fn execute(
        &mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> std::result::Result<MappingReply, ProgramError> {
        let mut budget = self.budget;
        // Steps that keep their action in place: the accept consumes it.
        match &mut self.action {
            Action::Child(item, ChildControl::Item(control)) => {
                return control
                    .execute(item.item(), router, decoder)
                    .map(MappingValue::Child);
            }
            Action::Child(item, ChildControl::Cache(control)) => {
                return control
                    .execute(item.item(), router, decoder)
                    .map(MappingValue::CacheChild);
            }
            Action::SharedItems(representation, ..) => {
                return Ok(source_reply(
                    GeometryRouter::shared_source_items(
                        representation.item(),
                        decoder,
                        &mut budget,
                    ),
                    representation.item().id,
                    budget,
                    |items| MappingValue::SharedItems(items, budget),
                ));
            }
            Action::StyledItems(pending) => {
                let items = GeometryRouter::styled_source_items(
                    &pending.representation,
                    decoder,
                    &mut budget,
                );
                return Ok(source_reply(items, pending.item_id, budget, |items| {
                    MappingValue::StyledItems(items, budget)
                }));
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
                    return Ok(MappingValue::Refused {
                        item_id: item.item().id,
                        refusal,
                        budget,
                    });
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
                source_reply(value, item.id, budget, |value| MappingValue::Entered {
                    budget,
                    item_id: item.id,
                    value,
                })
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
                    .map(Reached::item)
                    .ok_or(ProgramError::StaleRequest)?;
                if let Some(state) = &self.retained {
                    return Ok(source_reply(
                        Self::validate_retained_map(
                            rep_map,
                            decoder,
                            &state.selection,
                            &mut budget,
                        ),
                        rep_map.id,
                        budget,
                        |value| MappingValue::TypeMapEntered(value, budget),
                    ));
                }
                source_reply(
                    router.admit_type_map(rep_map, decoder, &mut budget),
                    rep_map.id,
                    budget,
                    |value| MappingValue::TypeMapEntered(value, budget),
                )
            }
            Action::Origin => {
                if self.retained.is_some() {
                    return Ok(self.retained_type_origin(router, decoder));
                }
                let rep_map = self
                    .rep_map
                    .as_ref()
                    .map(Reached::item)
                    .ok_or(ProgramError::StaleRequest)?;
                MappingValue::Origin(router.type_map_origin(rep_map, decoder))
            }
            Action::TypeFinish(origin) => {
                if self.retained.is_some() {
                    return self.finish_retained_type_map(origin);
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
                return Err(ProgramError::StaleRequest);
            }
        })
    }
}
