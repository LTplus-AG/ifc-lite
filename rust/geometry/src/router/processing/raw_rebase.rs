// SPDX-License-Identifier: MPL-2.0

//! Item-level RTC and local-anchor selection and bounds publication.

use super::super::frame_parts::mesh_bounds;
use super::super::rtc_offset::raw_coordinate::rtc_rebase_benefits;
use super::super::GeometryRouter;
use crate::Mesh;
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// The nearest f32 that does not shrink the interval: rounds a minimum down
/// and a maximum up, so an f32 box always encloses the f64 geometry.
pub(in crate::router) fn enclosing_f32(value: f64, is_min: bool) -> f32 {
    let rounded = value as f32;
    match (is_min, (rounded as f64).partial_cmp(&value)) {
        (true, Some(std::cmp::Ordering::Greater)) => rounded.next_down(),
        (false, Some(std::cmp::Ordering::Less)) => rounded.next_up(),
        _ => rounded,
    }
}

/// Publish object-frame `local_bounds` for a mesh rebased by `offset`
/// (metres, item frame). No-op for an empty mesh.
///
/// Public bounds stay in the pre-RTC object frame (the contract
/// `local_to_world` pairs with), reconstituted from the rebased f32 positions
/// in f64 and then rounded OUTWARD to the enclosing f32 box: at a 5,000,000 m
/// offset the f32 ULP is 0.5 m, so a 0.125 m face would otherwise round both
/// faces onto one value and publish a zero extent (#5026 review).
fn publish_object_frame_bounds(
    mesh: &mut Mesh,
    offset: (f64, f64, f64),
    unrebased_scale: Option<f64>,
) {
    if mesh.positions.is_empty() {
        return;
    }
    let rebased = mesh_bounds(mesh);
    let offset = [offset.0, offset.1, offset.2];
    let mut bounds = [0.0f32; 6];
    for axis in 0..3 {
        let min = rebased[axis] as f64 + offset[axis];
        let max = rebased[axis + 3] as f64 + offset[axis];
        if let Some(scale) = unrebased_scale {
            // Preserve the legacy object-frame bounds of a mesh that would
            // have been lowered without RTC, unless the extent disappeared.
            let plain = |value| ((value / scale) as f32) * scale as f32;
            bounds[axis] = plain(min);
            bounds[axis + 3] = plain(max);
        }
        if unrebased_scale.is_none() || (max > min && bounds[axis + 3] <= bounds[axis]) {
            bounds[axis] = enclosing_f32(min, true);
            bounds[axis + 3] = enclosing_f32(max, false);
        }
        if max > min && bounds[axis + 3] <= bounds[axis] {
            bounds[axis + 3] = bounds[axis].next_up();
        }
    }
    mesh.local_bounds = Some(bounds);
}

/// The f64 rebase a raw-coordinate item is meshed in, chosen by
/// [`GeometryRouter::raw_item_rebase`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct RawRebase {
    /// Subtracted from every coordinate before narrowing, in file units.
    pub(crate) file_units: (f64, f64, f64),
    /// The same offset in metres, in the item's frame.
    pub(crate) meters: (f64, f64, f64),
    /// The offset is the item's own anchor, carried in `origin` (#10835),
    /// not the model RTC, which the mesh is then marked `rtc_applied` for.
    pub(crate) anchored: bool,
    /// File-to-metre scale when the plain mesh previously published its bounds.
    unrebased_scale: Option<f64>,
}

impl RawRebase {
    /// Finish a unit-scaled mesh meshed in this rebase: publish its
    /// object-frame bounds and, for an anchor, hand the offset to `origin`
    /// so placement adds it back in f64.
    pub(crate) fn finish(self, mesh: &mut Mesh) {
        publish_object_frame_bounds(mesh, self.meters, self.unrebased_scale);
        if self.anchored {
            mesh.rtc_applied = false;
            let (x, y, z) = self.meters;
            for (origin, offset) in mesh.origin.iter_mut().zip([x, y, z]) {
                *origin += offset;
            }
        }
    }
}

impl GeometryRouter {
    /// How a raw-coordinate `item` is rebased in f64 before f32 narrowing,
    /// or `None` when it is not (#5684, #5698).
    ///
    /// With the per-mesh local frame on, an item whose coordinates are large
    /// in its own frame, and still large after the model RTC, is rebased by
    /// its OWN anchor ([`Self::representation_item_anchor_meters`], rounded to
    /// the metre), which [`RawRebase::finish`] carries in the
    /// mesh's f64 `origin`: the model RTC (`offset_meters`, item frame) can
    /// leave it kilometres away, where f32 has a millimetre grid, as the
    /// site-local frame does for an item 10 km from its `IfcSite` (#10835).
    /// Otherwise it is rebased by `offset_meters` when that reduces its
    /// coordinate magnitude, and marked `rtc_applied`.
    pub(crate) fn raw_item_rebase(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Option<RawRebase> {
        // Without a model RTC there is no rebase to replace: skip the probe,
        // which decodes the item's coordinates, for every item of such a model.
        if !self.has_rtc_offset() {
            return None;
        }
        let scale = self.unit_scale();
        let point = self.representation_item_first_vertex_meters(item, decoder)?;
        let shifted = (point.0 - offset_meters.0, point.1 - offset_meters.1, point.2 - offset_meters.2);
        let rtc_benefits = rtc_rebase_benefits(point, shifted);
        // An item the model RTC already brings near keeps that rebase.
        if self.local_frame_enabled() && crate::coord_is_large(point) && crate::coord_is_large(shifted) {
            if let Some(anchor) = self.representation_item_anchor_meters(item, decoder) {
                let anchor = (anchor.0.round(), anchor.1.round(), anchor.2.round());
                return Some(RawRebase {
                    file_units: (anchor.0 / scale, anchor.1 / scale, anchor.2 / scale),
                    meters: anchor,
                    anchored: true,
                    unrebased_scale: (!rtc_benefits).then_some(scale),
                });
            }
        }
        rtc_benefits.then_some(RawRebase {
            file_units: (offset_meters.0 / scale, offset_meters.1 / scale, offset_meters.2 / scale),
            meters: offset_meters,
            anchored: false,
            unrebased_scale: None,
        })
    }
}
