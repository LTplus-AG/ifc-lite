/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The canonical → wasm conversion for symbolic primitives.
//!
//! Split out of `symbolic.rs` (as `symbolic_truncation.rs` was, #2938) because
//! it is the one place in that file with a failure story of its own: everything
//! else there is a field and its getter, while this is a hand-written
//! transcription between two struct families that are field-for-field parallel
//! but share no type. Nothing in the compiler can see a pair transposed or a
//! field left behind here — only `symbolic_tests.rs` can — so the conversion and
//! its tests belong side by side rather than buried among the accessors.

use super::symbolic::{
    SymbolicCircle, SymbolicFillArea, SymbolicPolyline, SymbolicRepresentationCollection,
    SymbolicText,
};

impl SymbolicRepresentationCollection {
    /// Convert from the canonical `ifc_lite_processing::SymbolicData`
    /// (issue #843 follow-up — full parity refactor). The WASM-side
    /// extractor now delegates to the processing crate and converts the
    /// result here so the browser and the HTTP server produce bit-
    /// identical symbol streams from one canonical implementation.
    ///
    /// "Bit-identical" is the contract, so every field of every primitive has
    /// to cross — a field this function forgets is a field the browser silently
    /// never sees, while the server's JSON for the same file still carries it.
    pub fn from_data(data: ifc_lite_processing::SymbolicData) -> Self {
        let mut collection = Self::with_capacity(data.polylines.len(), data.circles.len());
        collection.truncated = data.truncated.clone();
        for p in data.polylines {
            collection.add_polyline(SymbolicPolyline::new(
                p.express_id,
                p.ifc_type,
                p.points,
                p.closed,
                p.world_y,
                p.representation,
            ));
        }
        for c in data.circles {
            collection.add_circle(SymbolicCircle::new(
                c.express_id,
                c.ifc_type,
                c.center_x,
                c.center_y,
                c.radius,
                c.world_y,
                c.start_angle,
                c.end_angle,
                c.representation,
            ));
        }
        for t in data.texts {
            collection.add_text(SymbolicText::new_styled(
                t.express_id,
                t.ifc_type,
                t.x,
                t.y,
                t.dir_x,
                t.dir_y,
                t.height,
                t.content,
                t.alignment,
                t.world_y,
                t.color,
                t.target_px,
                t.representation,
            ));
        }
        for f in data.fills {
            let fill = SymbolicFillArea::new(
                f.express_id,
                f.ifc_type,
                f.points,
                f.holes_offsets,
                f.fill_color,
                f.world_y,
                f.representation,
            );
            // `SymbolicFillArea::new` defaults to unhatched, so the hatching
            // style has to be applied explicitly. The viewer reads these five
            // fields straight off this object
            // (`apps/viewer/src/lib/overlay-parse/symbolic-flat.ts`), so
            // dropping them here draws every hatched region as a flat solid in
            // the browser while the JSON path carries the style intact.
            //
            // `hatch_angle_secondary` is NaN when there is no cross-hatch, and
            // NaN is exactly what the builder's `None` restores — so route the
            // absent case back through `Option` rather than handing the
            // sentinel on as though it were a real angle.
            collection.add_fill(if f.has_hatching {
                fill.with_hatching(
                    f.hatch_spacing,
                    f.hatch_angle,
                    Some(f.hatch_angle_secondary).filter(|a| !a.is_nan()),
                    f.hatch_line_width,
                )
            } else {
                fill
            });
        }
        collection
    }
}
