// SPDX-License-Identifier: MPL-2.0
//! One reached representation and one whole admitted item list at a time.
use crate::representation::{product_shape, Select};
use crate::Result;
use super::{ItemProgram, ItemListPolicy};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Owned item and the selected representation's annotation policy.
pub(crate) struct ReachedItem {
    pub item: DecodedEntity,
    pub fill_only: bool,
}

/// Representation/item error and filtering policies retained by each entry.
#[derive(Clone, Copy)]
pub(crate) enum EntryPolicy { MergedProduct, StyledProduct, OpeningItemMeshes, OpeningItemBounds }
impl EntryPolicy {
    fn opening(self) -> bool { matches!(self, Self::OpeningItemMeshes | Self::OpeningItemBounds) }
}

/// Owns reached control; no decoder or borrowed scope survives `poll`.
/// Descendants of a later item are never admitted early.
pub(crate) struct ProductProgram {
    policy: EntryPolicy,
    element: DecodedEntity,
    representations: std::vec::IntoIter<DecodedEntity>,
    items: ItemProgram,
    fill_only: bool,
    state: State,
}

enum State { Representations, AwaitItems(DecodedEntity), Items, Complete }

/// A poll performs no IFC reads, selected callbacks or numerical work.
pub(crate) enum TraversalPoll {
    Items(RepresentationItemsRequest),
    Item(ReachedItem),
    Pending,
    Complete,
}

pub(crate) struct RepresentationItemsRequest { representation: DecodedEntity }
impl RepresentationItemsRequest {
    pub(crate) fn admit(self, decoder: &mut EntityDecoder<'_>) -> Result<ItemProgram> {
        ItemProgram::admit(&self.representation, decoder, ItemListPolicy::Product)
    }
}

impl ProductProgram {
    #[cfg(test)]
    pub(crate) fn host_openings(host: &DecodedEntity, ids: &[u32]) -> super::openings::HostOpenings {
        super::openings::HostOpenings::new(host, ids)
    }

    pub(crate) fn admit(element: &DecodedEntity, policy: EntryPolicy, decoder: &mut EntityDecoder<'_>) -> Result<Option<Self>> {
        let Some(shape) = product_shape(element, decoder)? else { return Ok(None) };
        Ok(Some(Self::representations(element, policy, shape.into_selected(element, Select::Meshed))))
    }

    fn representations(element: &DecodedEntity, policy: EntryPolicy, reps: Vec<DecodedEntity>) -> Self {
        Self { element: element.clone(), policy, representations: reps.into_iter(),
            items: ItemProgram::empty(), fill_only: false, state: State::Representations,
            }
    }

    pub(crate) fn opening(element: &DecodedEntity, policy: EntryPolicy, decoder: &mut EntityDecoder<'_>) -> Result<Option<Self>> {
        debug_assert!(policy.opening());
        Ok(super::source::opening_representations(element, decoder)?
            .map(|reps| Self::representations(element, policy, reps)))
    }

    pub(crate) fn poll(&mut self) -> TraversalPoll {
        loop {
            match &self.state {
                State::Representations => {
                    let Some(representation) = self.representations.next() else {
                        self.state = State::Complete;
                        continue;
                    };
                    self.state = State::AwaitItems(representation.clone());
                    return TraversalPoll::Items(RepresentationItemsRequest { representation });
                }
                State::AwaitItems(_) => return TraversalPoll::Pending,
                State::Items => match self.items.next() {
                    Some(item) => return TraversalPoll::Item(ReachedItem {
                        item, fill_only: self.fill_only }),
                    None => self.state = State::Representations,
                },
                State::Complete => return TraversalPoll::Complete,
            }
        }
    }

    /// The common program authenticates the reply before this consuming
    /// assembly. Annotation policy is evaluated only after the whole Items list
    /// succeeds, as in the original reached source order.
    pub(crate) fn accept_items(&mut self, reply: Result<ItemProgram>) -> Result<()> {
        let State::AwaitItems(representation) =
            std::mem::replace(&mut self.state, State::Complete) else {
                return Err(crate::Error::geometry("No representation Items admission is pending"));
            };
        match crate::resource::observe(reply) {
            Ok(items) => {
                self.fill_only = !self.policy.opening()
                    && crate::router::annotation::is_fill_only_representation(&self.element, &representation);
                self.items = items;
                self.state = State::Items;
                Ok(())
            }
            Err(error @ crate::Error::ProgramStopped(_)) => Err(error),
            Err(_) if self.policy.opening() => {
                self.state = State::Representations;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }


}

#[cfg(test)]
#[path = "traversal_tests.rs"]
mod tests;
