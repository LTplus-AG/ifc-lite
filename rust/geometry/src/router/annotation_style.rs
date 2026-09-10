// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Acceptance only. Colour resolution remains canonical processing::style.
use super::annotation::invalid;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};

pub(super) fn validate(item_id: u32, decoder: &mut EntityDecoder) -> Result<()> {
    let ids = decoder.styled_item_ids(item_id)?.to_vec();
    let mut work = 512usize;
    let mut fills = 0usize;
    for id in ids {
        let styled = decoder.decode_by_id(id)?;
        for style_id in references(&styled, 1, &mut work)? {
            let style = decoder.decode_by_id(style_id)?;
            let assignment = decoder.get_raw_bytes(style_id).and_then(|raw| {
                EntityScanner::new(raw)
                    .next_entity()
                    .map(|(_, name, _, _)| name == "IFCPRESENTATIONSTYLEASSIGNMENT")
            }) == Some(true);
            if assignment {
                for inner in references(&style, 0, &mut work)? {
                    check_fill(&decoder.decode_by_id(inner)?, decoder, &mut work)?;
                    fills += 1;
                }
            } else {
                check_fill(&style, decoder, &mut work)?;
                fills += 1;
            }
            if fills > 1 {
                return Err(invalid("multiple fill styles are unsupported"));
            }
        }
    }
    Ok(())
}
fn references(entity: &DecodedEntity, index: usize, work: &mut usize) -> Result<Vec<u32>> {
    let list = entity
        .get_list(index)
        .ok_or_else(|| invalid("missing presentation references"))?;
    if list.is_empty() || list.len() > 64 || list.len() > *work {
        return Err(invalid(
            "presentation reference budget or cardinality invalid",
        ));
    }
    *work -= list.len();
    list.iter()
        .map(|v| {
            v.as_entity_ref()
                .ok_or_else(|| invalid("invalid presentation reference"))
        })
        .collect()
}
fn check_fill(style: &DecodedEntity, decoder: &mut EntityDecoder, work: &mut usize) -> Result<()> {
    if style.ifc_type != IfcType::IfcFillAreaStyle {
        return Err(invalid("unsupported annotation presentation style"));
    }
    let leaves = references(style, 1, work)?;
    if leaves.len() != 1 {
        return Err(invalid("mixed fill paint is unsupported"));
    }
    let leaf = decoder.decode_by_id(leaves[0])?;
    if leaf.ifc_type != IfcType::IfcColourRgb {
        return Err(invalid("hatch/tile or non-RGB fill paint is unsupported"));
    }
    for i in 1..=3 {
        if !leaf
            .get(i)
            .and_then(|a| a.as_float())
            .is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))
        {
            return Err(invalid("invalid RGB fill component"));
        }
    }
    Ok(())
}
