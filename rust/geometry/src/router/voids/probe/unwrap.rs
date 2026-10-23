// SPDX-License-Identifier: MPL-2.0
//! #7781: one bounded wrapper walk with the probes' existing selection rules.
use super::{checked_probe, GeometryRouter, MAX_EXTRUSION_EXTRACT_DEPTH};
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

#[derive(Clone, Copy)]
pub(super) struct UnwrapPolicy {
    through_booleans: bool,
    single_item: bool,
}

impl UnwrapPolicy {
    pub(super) const FIRST: Self = Self { through_booleans: true, single_item: false };
    pub(super) const SINGLE_UNCLIPPED: Self = Self { through_booleans: false, single_item: true };
}

impl GeometryRouter {
    /// Preserve each caller's initial chain: direction probes keep absence,
    /// while box/extrusion probes multiply their first map by identity too.
    /// This retains operation order, including signed-zero arithmetic.
    pub(super) fn unwrap_probe_solid(
        &self,
        mut current: DecodedEntity,
        mut chain: Option<Matrix4<f64>>,
        policy: UnwrapPolicy,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(DecodedEntity, Option<Matrix4<f64>>)>> {
        checked_probe(|terminal| {
            let mut visited = FxHashSet::default();
            for _ in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
                if !visited.insert(current.id) { return None; }
                match current.ifc_type {
                    IfcType::IfcExtrudedAreaSolid => return Some((current, chain)),
                    IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult
                        if policy.through_booleans => {
                        current = probe_result!(terminal, decoder.resolve_ref(current.get(1)?))??;
                    }
                    IfcType::IfcMappedItem => {
                        let source = probe_result!(terminal, decoder.resolve_ref(current.get(0)?))??;
                        let representation = probe_result!(terminal, decoder.resolve_ref(source.get(1)?))??;
                        // Transform admission precedes Items, as in all three callers.
                        if let Some(map) = probe_result!(terminal,
                            self.mapped_item_transform(&current, &source, decoder))? {
                            chain = Some(match chain.take() {
                                Some(parent) => parent * map,
                                None => map,
                            });
                        }
                        let mut items = probe_result!(terminal,
                            decoder.resolve_ref_list(representation.get(3)?))?.into_iter();
                        current = items.next()?;
                        if policy.single_item && items.next().is_some() { return None; }
                    }
                    _ => return None,
                }
            }
            None
        })
    }
}

#[cfg(test)]
#[path = "unwrap_tests.rs"]
mod tests;
