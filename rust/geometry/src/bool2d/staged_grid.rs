// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::ShapeType;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;
use i_overlay::i_float::adapter::FloatPointAdapter;

type Ring = Vec<[f64; 2]>;
type Shape = Vec<Ring>;

/// Use one grid for the precursor and its intersection with the original
/// cutters. Recomputing the origin from the snapped precursor can move shared
/// boundaries by one step and create false correction slivers (#10834).
pub(super) fn shared_overlay(
    subject: &[Ring],
    clip: &[Ring],
) -> impl Fn(&[Ring], &[Ring], OverlayRule, FillRule) -> Vec<Shape> {
    let adapter = FloatPointAdapter::<[f64; 2], i32>::with_iter_conservative(
        subject.iter().chain(clip).flatten(),
    );
    move |subject, clip, rule, fill| {
        let capacity = subject.iter().chain(clip).map(Vec::len).sum();
        // Both the original cutters and the precursor's snapped vertices
        // lie on the original adapter's enclosing grid.
        FloatOverlay::with_adapter(adapter.clone(), capacity)
            .unsafe_add_source(subject, ShapeType::Subject)
            .unsafe_add_source(clip, ShapeType::Clip)
            .overlay(rule, fill)
    }
}
