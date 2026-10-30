// SPDX-License-Identifier: MPL-2.0
//! #7781: single-chain wrapper visitors. Unlike NestedMaps::FirstChain these
//! select the first ITEM, not the first mapped item after visiting its siblings.
use super::{rep_items, MappedLevel};
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

// An eligibility miss is separate from a terminal source/resource outcome.
macro_rules! probe_result {
    ($terminal:expr, $operation:expr) => {{
        if let Err(error) = crate::resource::check_current() {
            *$terminal = Some(error.into());
            return None;
        }
        match crate::resource::observe($operation.map_err(crate::Error::from)) {
            Err(error @ crate::Error::ProgramStopped(_)) => {
                *$terminal = Some(error);
                return None;
            }
            result => result.ok(),
        }
    }};
}
pub(crate) use probe_result;

pub(crate) fn checked_probe<T>(operation: impl FnOnce(&mut Option<Error>) -> Option<T>) -> Result<Option<T>> {
    crate::resource::check_current()?;
    let mut terminal = None;
    let value = operation(&mut terminal);
    if let Some(error) = terminal {
        return Err(error);
    }
    crate::resource::check_current()?;
    Ok(value)
}

#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub through_booleans: bool,
    pub single_item: bool,
}

impl Policy {
    pub(crate) const FIRST: Self = Self {
        through_booleans: true,
        single_item: false,
    };
    pub(crate) const SINGLE_UNCLIPPED: Self = Self {
        through_booleans: false,
        single_item: true,
    };
}

enum WrapperPolicy {
    Extrusion { through_booleans: bool },
    // Layers retain arbitrarily long acyclic boolean chains (#960, #2866),
    // with no allocation for a non-boolean root and no mapped expansion.
    BooleanLeaf,
}

fn unwrap_item(
    mut current: DecodedEntity,
    decoder: &mut EntityDecoder,
    policy: WrapperPolicy,
    mut step: impl FnMut(DecodedEntity, &mut EntityDecoder) -> Result<Option<DecodedEntity>>,
) -> Result<Option<DecodedEntity>> {
    let mut visited = FxHashSet::default();
    loop {
        let boolean = matches!(
            current.ifc_type,
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
        );
        match policy {
            WrapperPolicy::BooleanLeaf if !boolean => return Ok(Some(current)),
            WrapperPolicy::BooleanLeaf => {}
            WrapperPolicy::Extrusion { .. } => {
                if visited.len() >= ifc_lite_core::MAX_MAPPED_ITEM_DEPTH as usize {
                    return Ok(None);
                }
            }
        }
        if !visited.insert(current.id) {
            return Ok(None);
        }
        if let WrapperPolicy::Extrusion { through_booleans } = policy {
            if current.ifc_type == IfcType::IfcExtrudedAreaSolid {
                return Ok(Some(current));
            }
            if !(current.ifc_type == IfcType::IfcMappedItem || boolean && through_booleans) {
                return Ok(None);
            }
        }
        let Some(next) = step(current, decoder)? else {
            return Ok(None);
        };
        current = next;
    }
}

/// Preserve the caller's initial chain: direction keeps absence, rectangular
/// and extrusion probes multiply the first mapping by identity, too. The map
/// reader retains the target/origin identity shortcuts and errors.
pub(crate) fn unwrap_solid(
    item: DecodedEntity,
    mut chain: Option<Matrix4<f64>>,
    policy: Policy,
    decoder: &mut EntityDecoder,
) -> Result<Option<(DecodedEntity, Option<Matrix4<f64>>)>> {
    crate::resource::check_current()?;
    let solid = unwrap_item(
        item,
        decoder,
        WrapperPolicy::Extrusion {
            through_booleans: policy.through_booleans,
        },
        |current, decoder| {
            checked_probe(|terminal| {
                if current.ifc_type != IfcType::IfcMappedItem {
                    return probe_result!(
                        terminal,
                        decoder.resolve_ref(current.get(ifc_lite_core::slot::IfcBooleanResult::FIRST_OPERAND.index())?)
                    )?;
                }
                // No type checks: all three probes historically accept these layouts
                // on malformed map/representation record types. Transform precedes Items.
                let map = probe_result!(
                    terminal,
                    decoder.resolve_ref(current.get(ifc_lite_core::slot::IfcMappedItem::MAPPING_SOURCE.index())?)
                )??;
                let mapped_rep = probe_result!(
                    terminal,
                    decoder.resolve_ref(
                        map.get(ifc_lite_core::slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())?
                    )
                )??;
                let level = MappedLevel {
                    item: current,
                    map,
                    mapped_rep,
                };
                if let Some(map) = probe_result!(terminal, level.local_transform(decoder))? {
                    chain = Some(match chain.take() {
                        Some(parent) => parent * map,
                        None => map,
                    });
                }
                let mut items = probe_result!(terminal, rep_items(&level.mapped_rep, decoder))?.into_iter();
                let next = items.next()?;
                if policy.single_item && items.next().is_some() {
                    return None;
                }
                Some(next)
            })
        },
    )?;
    checked_probe(|_| solid.map(|solid| (solid, chain)))
}

pub(crate) fn unwrap_boolean_leaf(item: DecodedEntity, decoder: &mut EntityDecoder) -> Result<Option<DecodedEntity>> {
    unwrap_item(item, decoder, WrapperPolicy::BooleanLeaf, |current, decoder| {
        let Some(id) = current.get_ref(ifc_lite_core::slot::IfcBooleanResult::FIRST_OPERAND.index()) else {
            return Ok(None);
        };
        Ok(Some(decoder.decode_by_id(id)?))
    })
}
