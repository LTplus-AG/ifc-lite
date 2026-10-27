// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: cache-independent logical admission, once per product. Root Items
//! members and every mapped occurrence consume the shared walk allowance.
//! Completed roots survive exhaustion; the current root is atomic and is
//! withheld, along with all later roots. No partially admitted source is meshed.

use super::{
    Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, ShapeError, WalkCtx, WalkRefusal,
    WalkVisitor,
};
use ifc_lite_core::{
    execution_owner::ExecutionIdentity, DecodedEntity, EntityDecoder, MAX_MAPPED_ITEM_DEPTH,
};

#[derive(Default)]
pub(crate) struct ProductItems {
    pub(crate) representations: Vec<(DecodedEntity, Vec<DecodedEntity>)>,
    pub(crate) refusal: Option<Box<(DecodedEntity, WalkRefusal)>>,
    pub(crate) shape_error: Option<Box<ShapeError>>,
    pending: Option<u32>,
    pub(crate) terminal: Option<Box<crate::resource::ProgramStop>>,
    owners: ProductOwners,
}

/// Executing controls retain only accepted roots and their source seal. Cold
/// admission failures and traversal scratch do not enlarge every program move.
pub(crate) struct AdmittedProduct {
    pub(crate) representations: Vec<(DecodedEntity, Vec<DecodedEntity>)>,
    owners: ProductOwners,
}

#[derive(Default)]
struct ProductOwners(Option<(ExecutionIdentity, ExecutionIdentity)>);

impl ProductOwners {
    #[inline(always)]
    fn validate(
        &self,
        router: &crate::GeometryRouter,
        decoder: &EntityDecoder,
    ) -> crate::Result<()> {
        if self.0 != Some((decoder.execution_identity(), router.execution_identity())) {
            return Err(crate::Error::geometry(
                "product admission execution owner changed",
            ));
        }
        Ok(())
    }
}

impl AdmittedProduct {
    #[inline(always)]
    pub(crate) fn validate(
        &self,
        router: &crate::GeometryRouter,
        decoder: &EntityDecoder,
    ) -> crate::Result<()> {
        if crate::resource::is_stopped() {
            crate::resource::check_current()?;
        }
        self.owners.validate(router, decoder)
    }
}

// Private, already charged root members. Retained validation includes skipped
// representations in `items`, but only selected roots continue the walk.
#[derive(Default)]
pub(crate) struct AdmittedRoots {
    pub(crate) representations: Vec<(DecodedEntity, Vec<DecodedEntity>)>,
    pub(crate) items: u32,
}

pub(crate) fn admit_retained_product(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    allowance: u32,
    router: &crate::GeometryRouter,
    roots: AdmittedRoots,
) -> ProductItems {
    let mut plan = ProductItems::default();
    let walk = RepresentationWalk {
        select: Select::Meshed,
        nested: NestedMaps::Expand {
            max_depth: MAX_MAPPED_ITEM_DEPTH,
            max_levels: allowance,
        },
    };
    if plan.check() == Flow::Continue {
        walk.admitted_product(element, decoder, &mut plan, roots);
    }
    plan.seal(router, decoder);
    plan
}

#[inline(always)]
pub(crate) fn admit_product(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    allowance: u32,
    router: &crate::GeometryRouter,
) -> ProductItems {
    let walk = RepresentationWalk {
        select: Select::Meshed,
        nested: NestedMaps::Expand {
            max_depth: MAX_MAPPED_ITEM_DEPTH,
            max_levels: allowance,
        },
    };
    let mut plan = ProductItems::default();
    // Deliberately no mesh/source cache and no SkipChildren: a hit pays the
    // same logical cost as a miss. Weights are not cached across mutable source
    // decoders. The walk admits lists BEFORE resolving/allocating their items.
    // Preserve the extractor's historical partial results on a later shape
    // error. Strict mesh consumers still propagate that error before meshing.
    if plan.check() == Flow::Continue {
        plan.shape_error = walk
            .product_admission(element, decoder, &mut plan)
            .err()
            .map(Box::new);
    }
    plan.seal(router, decoder);
    plan
}

impl ProductItems {
    fn seal(&mut self, router: &crate::GeometryRouter, decoder: &EntityDecoder) {
        // No callback or source access occurs between the walk and this seal.
        // Consumers poll stops before using the plan, including shape errors.
        // Seal after lazy decoder initialization; execution validates this owner.
        self.owners = ProductOwners(Some((
            decoder.execution_identity(),
            router.execution_identity(),
        )));
    }

    fn check(&mut self) -> Flow {
        if crate::resource::is_stopped() {
            self.terminal = crate::resource::check_current().err().map(Box::new);
        }
        if self.terminal.is_some() {
            Flow::Stop
        } else {
            Flow::Continue
        }
    }

    #[inline(always)]
    pub(crate) fn validate(
        &self,
        router: &crate::GeometryRouter,
        decoder: &EntityDecoder,
    ) -> crate::Result<()> {
        if crate::resource::is_stopped() {
            crate::resource::check_current()?;
        }
        if let Some(stop) = &self.terminal {
            return Err((**stop).into());
        }
        self.owners.validate(router, decoder)
    }

    /// Called only after strict admission succeeded and its refusal was reported.
    pub(crate) fn into_admitted(self) -> AdmittedProduct {
        AdmittedProduct {
            representations: self.representations,
            owners: self.owners,
        }
    }

    /// Strict meshes reject a later malformed representation before any root
    /// executes. Drawings deliberately retain profiles from earlier roots.
    pub(crate) fn strict(&mut self) -> crate::Result<()> {
        if crate::resource::is_stopped() {
            crate::resource::check_current()?;
        }
        if let Some(stop) = &self.terminal {
            return Err((**stop).into());
        }
        if let Some(error) = self.shape_error.take() {
            return Err((*error).into());
        }
        Ok(())
    }

    /// All members were charged and decoded by root_items (or strict retained
    /// validation). A flat root list needs no mapped expansion or member clones.
    pub(super) fn direct_items(&mut self, items: Vec<DecodedEntity>) -> Flow {
        if self.check() == Flow::Stop {
            return Flow::Stop;
        }
        if let Some((_, roots)) = self.representations.last_mut() {
            *roots = items;
        }
        Flow::Continue
    }

    fn push(&mut self, item: DecodedEntity) {
        if let Some((_, items)) = self.representations.last_mut() {
            items.push(item);
        }
    }
}

impl WalkVisitor for ProductItems {
    fn shape_rep(&mut self, rep: &DecodedEntity) -> Flow {
        if self.check() == Flow::Stop {
            return Flow::Stop;
        }
        self.representations.push((rep.clone(), Vec::new()));
        Flow::Continue
    }

    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        // A nested plain member is already decoded and charged. This visitor
        // does no source work for it; the root's leave polls before acceptance.
        if !at.path.is_empty() {
            return Flow::Continue;
        }
        if self.check() == Flow::Stop {
            return Flow::Stop;
        }
        self.push(item.clone());
        Flow::Continue
    }

    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        if self.check() == Flow::Stop {
            return Flow::Stop;
        }
        if at.path.is_empty() {
            self.pending = Some(level.item.id);
        }
        Flow::Continue
    }

    fn leave_map(&mut self, level: &MappedLevel) {
        self.check();
        if self.pending == Some(level.item.id) {
            self.pending = None;
            if self.refusal.is_none() && self.terminal.is_none() {
                self.push(level.item.clone());
            }
        }
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        if self.check() == Flow::Stop {
            return;
        }
        if matches!(why, WalkRefusal::Budget { .. }) {
            self.refusal = Some(Box::new((item.clone(), why)));
        } else if at.path.is_empty() && self.pending.is_none() {
            // An unresolved root never entered. Retain it so the actual
            // consumer reports its normal decode/source refusal. Nested depth
            // and cycle refusals likewise belong to the actual consumer.
            self.push(item.clone());
        }
    }
}
