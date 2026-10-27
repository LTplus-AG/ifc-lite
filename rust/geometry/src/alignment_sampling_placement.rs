// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Schema validation before the canonical (renderer-tolerant) placement resolver.
//! No transform is computed here. Unsupported placement families fail explicitly.
use crate::placement::{validate_chain, ChainPolicy};
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Alignment sampling accepts local links with exactly-3D, non-degenerate,
/// non-parallel frames; the walk is the shared one (no depth cap, D27).
const POLICY: ChainPolicy = ChainPolicy {
    grid: false,
    linear: false,
    planar_relative: false,
    strict_spatial: true,
};

pub(super) fn validate_placement(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<()> {
    let Some(attr) = entity.get(5).filter(|a| !a.is_null()) else {
        return Ok(());
    };
    let id = attr
        .as_entity_ref()
        .ok_or_else(|| Error::geometry("ObjectPlacement must be a reference"))?;
    let placement = decoder.decode_by_id(id)?;
    validate_chain(&placement, decoder, &POLICY).map_err(Into::into)
}
