// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::prepass::{resolve_prepass, PrepassSpans, ResolveOptions, ResolvedPrepass};
use super::source::Source;
use ifc_lite_core::EntityScanner;

/// Reuse the ordinary style/material/type resolver, including first-wins
/// precedence. Source::new has already bounded every source row/reference.
pub(super) fn appearance(bytes: &[u8], source: &mut Source<'_>) -> ResolvedPrepass {
    let mut spans = PrepassSpans::default();
    let mut scan = EntityScanner::new(bytes);
    while let Some((id, name, start, end)) = scan.next_entity() {
        spans.stash(name, id, start, end);
    }
    resolve_prepass(&spans, &mut source.decoder, ResolveOptions::default())
}
