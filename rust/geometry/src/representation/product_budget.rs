// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: cache-independent logical admission, once per product. Root Items
//! members and every mapped occurrence consume the shared walk allowance.
//! Completed roots survive exhaustion; the current root is atomic and is
//! withheld, along with all later roots. No partially admitted source is meshed.

use super::{Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, ShapeError,
    WalkCtx, WalkRefusal, WalkVisitor};
use ifc_lite_core::{DecodedEntity, EntityDecoder, MAX_MAPPED_ITEM_DEPTH};

#[derive(Default)]
pub(crate) struct ProductItems {
    pub(crate) representations: Vec<(DecodedEntity, Vec<DecodedEntity>)>,
    pub(crate) refusal: Option<(DecodedEntity, WalkRefusal)>,
    pub(crate) shape_error: Option<ShapeError>,
    pending: Option<DecodedEntity>,
}

pub(crate) fn admit_product(
    element: &DecodedEntity, decoder: &mut EntityDecoder, allowance: u32,
) -> ProductItems {
    let walk = RepresentationWalk {
        select: Select::Meshed,
        nested: NestedMaps::Expand { max_depth: MAX_MAPPED_ITEM_DEPTH, max_levels: allowance },
    };
    let mut plan = ProductItems::default();
    // Deliberately no mesh/source cache and no SkipChildren: a hit pays the
    // same logical cost as a miss. Weights are not cached across mutable source
    // decoders. The walk admits lists BEFORE resolving/allocating their items.
    // Preserve the extractor's historical partial results on a later shape
    // error. Strict mesh consumers still propagate that error before meshing.
    plan.shape_error = walk.product(element, decoder, &mut plan).err();
    plan
}

impl ProductItems {
    fn push(&mut self, item: DecodedEntity) {
        if let Some((_, items)) = self.representations.last_mut() {
            items.push(item);
        }
    }
}

impl WalkVisitor for ProductItems {
    fn shape_rep(&mut self, rep: &DecodedEntity) -> Flow {
        self.representations.push((rep.clone(), Vec::new()));
        Flow::Continue
    }

    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        if at.path.is_empty() {
            self.push(item.clone());
        }
        Flow::Continue
    }

    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        if at.path.is_empty() {
            self.pending = Some(level.item.clone());
        }
        Flow::Continue
    }

    fn leave_map(&mut self, level: &MappedLevel) {
        if self.pending.as_ref().is_some_and(|root| root.id == level.item.id) {
            if let Some(root) = self.pending.take() {
                if self.refusal.is_none() {
                    self.push(root);
                }
            }
        }
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        if matches!(why, WalkRefusal::Budget { .. }) {
            self.refusal = Some((item.clone(), why));
        } else if at.path.is_empty() && self.pending.is_none() {
            // An unresolved root never entered. Retain it so the actual
            // consumer reports its normal decode/source refusal. Nested depth
            // and cycle refusals likewise belong to the actual consumer.
            self.push(item.clone());
        }
    }
}
