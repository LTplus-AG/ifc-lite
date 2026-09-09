// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Match the loader's coordinate-frame choice before producing f32 meshes.
//! Survey coordinates must not become geometry-loss goldens (#3925).
//!
//! The frame is a pure function of the file, so it is derived ONCE per model and
//! reused for every host the sweep walks (#4127). Deriving it per host made each
//! `process()` call walk the whole file twice unconditionally: an entity index
//! over every record, then a second walk calling `has_geometry_by_name` on each
//! to collect the geometry jobs. Placement sampling rides on that second walk and
//! is capped at 50 usable jobs, so it is only a third full pass when nearly every
//! job abstains. If EVERY job abstains, the `scan_placement_bounds` fallback adds
//! two more whole-file walks on top, so the real worst case is five.
//! `triangulation_invariance`
//! makes two of those calls per void host and a third for a torn one, which is
//! what stopped the heavy lane fitting the 60 minutes
//! `.github/workflows/geometry-census-heavy.yml` budgets it (`timeout-minutes: 60`).
//! The before/after timings are in #4127 and in the commit that made this change.
//!
//! # What is still per host, and what is still O(file)
//!
//! ONLY the frame is shared. Every host still gets its own [`GeometryRouter`]
//! and its own [`EntityDecoder`], so the router's mapped-item, dedup,
//! geometry-hash and diagnostic state stays per host exactly as it was. A
//! shared router would carry one host's cached mapped items and its
//! consumed-void bookkeeping into the next host, which is a question about
//! census rows rather than about speed. The two things that ARE shared are pure
//! functions of the content: the entity index (id -> byte span) and the RTC
//! offset.
//!
//! That leaves ONE per-host walk in place, and this note does not claim
//! otherwise: [`ModelFrame::router`] calls `GeometryRouter::with_units`, whose
//! `scan_unit_scale` (`rust/geometry/src/router/mod.rs`) scans entities from the
//! start of the file until it hits `IFCPROJECT`. On most models that stops in
//! the first few KB and costs nothing measurable. On some it does not, because
//! the exporter emitted `IFCPROJECT` last; measured on this corpus:
//!
//! | fixture | first `IFCPROJECT` | file size |
//! |---|---|---|
//! | `ara3d/duplex.ifc` | byte 2,380,634 | 2,380,763 |
//! | `ara3d/dental_clinic.ifc` | byte 9,496,389 | 13,003,205 |
//! | `various/01_BIMcollab_Example_ARC.ifc` | byte 6,252,152 (line 100819) | 18,230,149 |
//!
//! All three are in `manifest.json` under `MAX_FIXTURE_BYTES`, so the default
//! sweep walks them, and on those the per-host cost is still effectively
//! O(file).
//!
//! The unit scale is NOT hoisted here, deliberately. It could only be reused by
//! building the per-host router from `GeometryRouter::with_scale_and_rtc`, which
//! unlike `with_units` does NOT call `arm_content_dedup()`. Swapping it in would
//! silently turn item content-dedup off for the census and could move the rows,
//! which is the one thing this change must not do. Hoisting the scale is a
//! separate change that has to argue about dedup, not about speed.

use ifc_lite_core::{
    build_entity_index, has_geometry_by_name, EntityDecoder, EntityIndex, EntityScanner,
};
use ifc_lite_geometry::GeometryRouter;
use std::sync::Arc;

/// One model's re-derivable, host-independent inputs to the census.
///
/// The frame STORES the content it was built from and hands it back out itself.
/// That, not the lifetime, is what makes a wrong pairing unrepresentable: two
/// distinct `String`s can both yield `&'a str` for one `'a`, so a `content`
/// parameter on the methods below would type-check against a DIFFERENT string.
/// Do not re-add one. The index holds absolute byte spans into `content` and
/// [`EntityDecoder`] slices them unchecked, so the wrong pairing decodes the
/// wrong entities or panics out of bounds.
pub struct ModelFrame<'a> {
    /// The exact content the index and the offset were derived from.
    content: &'a str,
    /// Read-only entity id -> byte span map. `EntityDecoder::with_index` already
    /// wraps its argument in an `Arc` internally, so handing every host the same
    /// `Arc` is the identical store, built once.
    index: Arc<EntityIndex>,
    /// The RTC offset the loader would pick for this file.
    offset: (f64, f64, f64),
}

impl<'a> ModelFrame<'a> {
    pub fn new(content: &'a str) -> Self {
        let index = Arc::new(build_entity_index(content));
        let mut decoder = EntityDecoder::with_arc_index(content, Arc::clone(&index));
        let offset = detect_rtc_offset(content, &mut decoder);
        Self { content, index, offset }
    }

    /// A FRESH decoder over this model. Only the read-only index is shared; the
    /// entity, point and placement caches are new for every host.
    pub fn decoder(&self) -> EntityDecoder<'a> {
        EntityDecoder::with_arc_index(self.content, Arc::clone(&self.index))
    }

    /// A FRESH router carrying this model's frame, per host. See the module note
    /// on why the router itself is not the thing that gets hoisted, and on the
    /// unit scan this still repeats per host.
    pub fn router(&self, decoder: &mut EntityDecoder) -> GeometryRouter {
        let mut router = GeometryRouter::with_units(self.content, decoder);
        router.set_rtc_offset(self.offset);
        router
    }
}

/// The loader's offset choice: the site placement's translation when it is not
/// at the origin, otherwise the sampled/bounds fallback over every geometry job.
fn detect_rtc_offset(content: &str, decoder: &mut EntityDecoder) -> (f64, f64, f64) {
    let router = GeometryRouter::with_units(content, decoder);
    let mut scan = EntityScanner::new(content);
    let mut jobs = Vec::new();
    let mut site = None;
    while let Some((id, name, start, end)) = scan.next_entity() {
        if name == "IFCSITE" && site.is_none() {
            site = Some((id, start, end));
        }
        if has_geometry_by_name(name) {
            jobs.push((id, start, end, ifc_lite_core::legacy_aware_ifc_type(name)));
        }
    }
    let site_offset = site.and_then(|(id, start, end)| {
        let e = decoder.decode_at_with_id(id, start, end).ok()?;
        let m = router.resolve_scaled_placement(&e, decoder).ok()?;
        let t = (m[12], m[13], m[14]);
        (t.0.abs() > 1e-9 || t.1.abs() > 1e-9 || t.2.abs() > 1e-9).then_some(t)
    });
    site_offset
        .unwrap_or_else(|| router.detect_rtc_offset_with_fallback(&jobs, decoder, content.as_bytes()))
}
