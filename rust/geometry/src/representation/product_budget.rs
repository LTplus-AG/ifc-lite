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
    pub(crate) terminal: Option<crate::resource::ProgramStop>,
    decoder: Option<ifc_lite_core::execution_owner::ExecutionIdentity>,
    router: Option<ifc_lite_core::execution_owner::ExecutionIdentity>,
}

pub(crate) fn admit_product(
    element: &DecodedEntity, decoder: &mut EntityDecoder, allowance: u32,
    router: &crate::GeometryRouter,
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
    if plan.check() == Flow::Continue {
        plan.shape_error = walk.product(element, decoder, &mut plan).err();
    }
    plan.check();
    // Lazy index/unit initialization during admission belongs to this owner.
    // Seal AFTER that initialization, then validate before every root execution.
    plan.decoder = Some(decoder.execution_identity());
    plan.router = Some(router.execution_identity());
    plan
}

impl ProductItems {
    fn check(&mut self) -> Flow {
        if let Err(stop) = crate::resource::check_current() {
            self.terminal = Some(stop);
        }
        if self.terminal.is_some() { Flow::Stop } else { Flow::Continue }
    }

    pub(crate) fn validate(&self, router: &crate::GeometryRouter, decoder: &EntityDecoder)
        -> crate::Result<()> {
        crate::resource::check_current()?;
        if let Some(stop) = self.terminal { return Err(stop.into()); }
        if self.decoder != Some(decoder.execution_identity())
            || self.router != Some(router.execution_identity()) {
            return Err(crate::Error::geometry("product admission execution owner changed"));
        }
        Ok(())
    }

    /// Strict meshes reject a later malformed representation before any root
    /// executes. Drawings deliberately retain profiles from earlier roots.
    pub(crate) fn strict(&mut self) -> crate::Result<()> {
        crate::resource::check_current()?;
        if let Some(stop) = self.terminal { return Err(stop.into()); }
        if let Some(error) = self.shape_error.take() { return Err(error.into()); }
        Ok(())
    }

    fn push(&mut self, item: DecodedEntity) {
        if let Some((_, items)) = self.representations.last_mut() {
            items.push(item);
        }
    }
}

impl WalkVisitor for ProductItems {
    fn shape_rep(&mut self, rep: &DecodedEntity) -> Flow {
        if self.check() == Flow::Stop { return Flow::Stop; }
        self.representations.push((rep.clone(), Vec::new()));
        Flow::Continue
    }

    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        if self.check() == Flow::Stop { return Flow::Stop; }
        if at.path.is_empty() {
            self.push(item.clone());
        }
        Flow::Continue
    }

    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        if self.check() == Flow::Stop { return Flow::Stop; }
        if at.path.is_empty() {
            self.pending = Some(level.item.clone());
        }
        Flow::Continue
    }

    fn leave_map(&mut self, level: &MappedLevel) {
        self.check();
        if self.pending.as_ref().is_some_and(|root| root.id == level.item.id) {
            if let Some(root) = self.pending.take() {
                if self.refusal.is_none() && self.terminal.is_none() {
                    self.push(root);
                }
            }
        }
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        if self.check() == Flow::Stop { return; }
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
