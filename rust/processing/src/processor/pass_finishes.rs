// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native pass's `on_finishes` event (#8341 C4-13a), one entry per mesh
//! of the batch about to be emitted.

use super::ProcessingSink;
use crate::element::StyleSource;
use crate::style::ModelFinishes;

/// `on_finishes` for the batch about to be emitted (`styles`, one per mesh),
/// when the request asked for finishes: each mesh's finish from the source its colour came from
/// (#10698), never from its colour. The pass resolves deferred styles before
/// meshing whenever finishes are asked for, so every source here is final.
pub(super) fn emit_finishes(
    sink: &mut dyn ProcessingSink,
    finishes: Option<&mut ModelFinishes<'_>>,
    styles: &[StyleSource],
) {
    let Some(finishes) = finishes else { return };
    let batch: Vec<_> = styles.iter().map(|&style| finishes.finish_for_source(style)).collect();
    sink.on_finishes(&batch);
}
