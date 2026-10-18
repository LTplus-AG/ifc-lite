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
pub(crate) enum EntryPolicy { MergedProduct, StyledProduct, TypeMap, OpeningItemMeshes, OpeningItemBounds }
impl EntryPolicy {
    fn opening(self) -> bool { matches!(self, Self::OpeningItemMeshes | Self::OpeningItemBounds) }
}

/// Owns reached control; no decoder or borrowed scope survives `next`.
/// Descendants of a later item are never admitted early.
pub(crate) struct ProductProgram {
    policy: EntryPolicy,
    element: DecodedEntity,
    representations: std::vec::IntoIter<DecodedEntity>,
    items: ItemProgram,
    fill_only: bool,
    state: State,
    resources: super::resources::MergedResources,
}

enum State { Representations, Items, Complete }

enum SourceAdmission {
    RepresentationItems(DecodedEntity),
}

enum AdmissionValue {
    Items(ItemProgram),
}

impl ProductProgram {
    pub(crate) fn admit(element: &DecodedEntity, policy: EntryPolicy, decoder: &mut EntityDecoder<'_>) -> Result<Option<Self>> {
        let Some(shape) = product_shape(element, decoder)? else { return Ok(None) };
        Ok(Some(Self::representations(element, policy, shape.into_selected(element, Select::Meshed))))
    }

    fn representations(element: &DecodedEntity, policy: EntryPolicy, reps: Vec<DecodedEntity>) -> Self {
        Self { element: element.clone(), policy, representations: reps.into_iter(),
            items: ItemProgram::empty(), fill_only: false, state: State::Representations,
            resources: Default::default() }
    }

    pub(crate) fn opening(element: &DecodedEntity, policy: EntryPolicy, decoder: &mut EntityDecoder<'_>) -> Result<Option<Self>> {
        debug_assert!(policy.opening());
        Ok(super::source::opening_representations(element, decoder)?
            .map(|reps| Self::representations(element, policy, reps)))
    }

    pub(super) fn type_map(rep_map: &DecodedEntity, representation: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Result<Self> {
        // Whole Items precede the source claim and every child, even for non-Body maps.
        let items = ItemProgram::admit(representation, decoder, ItemListPolicy::RequiredMap)?;
        let mut program = Self::representations(rep_map, EntryPolicy::TypeMap, Vec::new());
        program.items = items;
        program.state = State::Items;
        Ok(program)
    }

    pub(crate) fn merge(&mut self, mesh: crate::Mesh, instancing: bool) {
        self.resources.merge(mesh, instancing);
    }

    pub(crate) fn finish_merged(self, instancing: bool) -> super::resources::MergedParts {
        self.resources.finish(instancing)
    }

    pub(crate) fn next(&mut self, decoder: &mut EntityDecoder<'_>) -> Result<Option<ReachedItem>> {
        loop {
            match self.state {
                State::Representations => {
                    let Some(rep) = self.representations.next() else { self.state = State::Complete; continue };
                    // Historical whole-list admission precedes annotation policy
                    // and the first child, even if the final child reference fails.
                    let value = match self.admit_source(SourceAdmission::RepresentationItems(rep.clone()), decoder) {
                        Ok(value) => value,
                        Err(_) if self.policy.opening() => continue,
                        Err(error) => return Err(error),
                    };
                    let AdmissionValue::Items(items) = value;
                    self.fill_only = !self.policy.opening() && crate::router::annotation::is_fill_only_representation(&self.element, &rep);
                    self.items = items;
                    self.state = State::Items;
                }
                State::Items => match self.items.next() {
                    Some(item) => return Ok(Some(ReachedItem { item, fill_only: self.fill_only })),
                    None => self.state = State::Representations,
                },
                State::Complete => return Ok(None),
            }
        }
    }

    fn admit_source(&self, request: SourceAdmission, decoder: &mut EntityDecoder<'_>) -> Result<AdmissionValue> {
        Ok(match request {
            SourceAdmission::RepresentationItems(rep) => AdmissionValue::Items(ItemProgram::admit(&rep, decoder, ItemListPolicy::Product)?),
        })
    }
}
