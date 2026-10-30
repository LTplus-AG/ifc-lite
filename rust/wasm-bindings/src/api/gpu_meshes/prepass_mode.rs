// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Internal orchestration choices; the JS positional ABI stays unchanged.
use super::prepass_owned_columns::ShardedColumns;

pub(super) enum PrepassMode<'a> {
    Serial,
    /// Columns supply the full index; worker shards own style resolution.
    Sharded(ShardedColumns<'a>),
}

pub(super) struct PrepassOptions<'a> {
    pub(super) mode: PrepassMode<'a>,
    pub(super) source_fingerprint: bool,
}

impl<'a> PrepassOptions<'a> {
    pub(super) fn serial(source_fingerprint: bool) -> Self {
        Self {
            mode: PrepassMode::Serial,
            source_fingerprint,
        }
    }
    pub(super) fn sharded(columns: ShardedColumns<'a>, source_fingerprint: bool) -> Self {
        Self {
            mode: PrepassMode::Sharded(columns),
            source_fingerprint,
        }
    }
}
