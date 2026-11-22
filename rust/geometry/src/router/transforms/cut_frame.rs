// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The frame a voided host is cut in: the root of its placement chain.
//!
//! Opening classification and the void-cut strategy chain read axis
//! alignment, bounds and f32 positions in whatever frame the operands are in.
//! In world coordinates that made the cut depend on where the model sits: the
//! same building under a rotated `IfcSite` took different strategies and came
//! back with a different triangulation.
//!
//! The root of a host's placement chain, when it is an `IfcSite`'s placement,
//! is the rigid placement of the whole model. While a
//! [`CutFrameScope`] is open, every placement the router resolves is
//! expressed relative to that root and the model RTC offset reads as zero, so
//! the host, its openings and the whole cut see what they would see with the
//! root at the origin. The void program then places the finished cut by the
//! root placement, and the RTC shift with it.
//!
//! Relative placements come from [`placement::resolve_chain_relative`], which
//! composes only the links below the root: the root's own numbers never enter
//! the cut. A chain whose root is the identity is in this frame already and
//! keeps the caller's, and so does a chain whose root places something other
//! than a site (a storey or a host placed absolutely): moving such a host to
//! another root that keeps it where it is must leave its mesh as it was, and
//! only the caller's frame does that.

use super::{instancing_enabled, GeometryRouter};
use crate::math::aabb::Aabb3;
use crate::math::mat4;
use crate::placement::{self, LinkKind, PlacementResult};
use crate::Mesh;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;
use std::cell::{Cell, RefCell};

/// The open cut frame of one router: the root placement's id, and the
/// relative placements resolved under it, keyed by placement id.
#[derive(Default)]
pub(crate) struct CutFrameSlot {
    base: Cell<Option<u32>>,
    relative: RefCell<FxHashMap<u32, Matrix4<f64>>>,
}

/// Restores the frame that was open before it on drop, an unwind included.
pub(crate) struct CutFrameScope<'a> {
    slot: &'a CutFrameSlot,
    previous: Option<u32>,
}

impl Drop for CutFrameScope<'_> {
    fn drop(&mut self) {
        if self.slot.base.replace(self.previous) != self.previous {
            self.slot.relative.borrow_mut().clear();
        }
    }
}

impl GeometryRouter {
    /// Resolve placements relative to the placement `base` until the scope drops.
    fn enter_cut_frame(&self, base: u32) -> CutFrameScope<'_> {
        let slot = &self.cut_frame;
        let previous = slot.base.replace(Some(base));
        if previous != Some(base) {
            slot.relative.borrow_mut().clear();
        }
        CutFrameScope { slot, previous }
    }

    #[inline]
    pub(crate) fn in_cut_frame(&self) -> bool {
        self.cut_frame.base.get().is_some()
    }

    /// `product`'s unscaled `ObjectPlacement` in the open frame: the world
    /// transform when none is open. `Ok(None)` is an absent placement in the
    /// world frame; under a cut frame an absent placement is the world
    /// origin, so it resolves to the inverse of the frame's root.
    pub(super) fn placement_in_frame(
        &self,
        product: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> PlacementResult<Option<Matrix4<f64>>> {
        let Some(base_id) = self.cut_frame.base.get() else {
            return placement::resolve_object_placement(product, decoder);
        };
        let target = decoder.resolve_optional(product, slot::IfcProduct::OBJECT_PLACEMENT.index())?;
        // No placement has id 0, so it keys the absent one.
        let key = target.as_ref().map_or(0, |placement| placement.id);
        if let Some(known) = self.cut_frame.relative.borrow().get(&key) {
            return Ok(Some(*known));
        }
        let base = decoder.decode_by_id(base_id)?;
        let relative = match &target {
            Some(placement) => placement::resolve_chain_relative(placement, &base, decoder)?,
            None => placement::resolve_chain(&base, decoder)?.try_inverse().ok_or(
                placement::PlacementError::Policy { at: base_id, rule: "placement frame is not invertible" },
            )?,
        };
        self.cut_frame.relative.borrow_mut().insert(key, relative);
        Ok(Some(relative))
    }

    /// Place a mesh cut in a root frame into the caller's frame by the root
    /// placement. Runs with the cut frame closed, so the world step sees the
    /// caller's RTC offset. The object-frame capture (#1474) is the cut's
    /// bounds in the host's own frame, paired with the host's whole
    /// placement; with a singular host placement every part carries none.
    ///
    /// The cut is welded first, for the reason [`Self::place_mesh`] gives:
    /// the weld keys on f32 bits, so welding the placed result would make the
    /// vertex buffer depend on where the model sits (#4103).
    pub(crate) fn place_root_frame_cut(&self, mesh: &mut Mesh, at: &RootPlacement) {
        crate::mesh_weld::weld_mesh(mesh);
        // As `place_mesh` does for a placed product: a host cut in a root
        // frame has a placement.
        if let Some(meta) = mesh.instance_meta.as_mut() {
            meta.transform = mat4::from_na(&at.host);
        }
        self.bake_root_frame_cut(mesh, at);
    }

    /// [`Self::place_root_frame_cut`] for a sub-mesh, carrying its UVs.
    pub(crate) fn place_root_frame_cut_sub(&self, sub: &mut crate::SubMesh, at: &RootPlacement) {
        crate::mesh_weld::weld_sub_mesh(sub);
        // As `place_sub_meshes` does: only with instancing on.
        if instancing_enabled() {
            if let Some(meta) = sub.mesh.instance_meta.as_mut() {
                meta.transform = mat4::from_na(&at.host);
            }
        }
        self.bake_root_frame_cut(&mut sub.mesh, at);
    }

    // Out of line, as is `bounds_in`: both placement paths reach it, and
    // inlining it into each cost 500 bytes of engine wasm.
    #[inline(never)]
    fn bake_root_frame_cut(&self, mesh: &mut Mesh, at: &RootPlacement) {
        debug_assert!(!self.in_cut_frame(), "a root-frame cut is placed with its frame closed");
        // Bounds the cut carried could be in any frame it passed through, so
        // they are recomputed. The bake would pair root-frame bounds with
        // `root`; the host's own frame is what the capture promises.
        let bounds = at.to_host.filter(|_| !mesh.positions.is_empty()).map(|to_host| {
            let b = bounds_in(mesh, &to_host);
            let enclose = super::super::raw_rebase::enclosing_f32;
            let (lo, hi) = (b.min.map(|v| enclose(v, true)), b.max.map(|v| enclose(v, false)));
            [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]
        });
        self.transform_mesh_world(mesh, &at.root);
        // Written after the bake, which captures its own pair.
        (mesh.local_bounds, mesh.local_to_world) = (bounds, at.to_host.map(|_| mat4::from_na(&at.host)));
    }
}

/// The f64 box of `mesh`'s positions mapped by `m`.
#[inline(never)]
fn bounds_in(mesh: &Mesh, m: &Matrix4<f64>) -> Aabb3 {
    let o = mesh.origin;
    Aabb3::from_points(mesh.positions.chunks_exact(3).map(|c| {
        let p = m.transform_point(&nalgebra::Point3::new(c[0] as f64 + o[0], c[1] as f64 + o[1], c[2] as f64 + o[2]));
        [p.x, p.y, p.z]
    }))
}

/// Where a finished root-frame cut goes: `root` is the root placement and
/// `host` the host's whole placement (`root` times the host placement
/// relative to it, so the two compose exactly), both in the caller's frame
/// and in metres; `to_host` maps the root frame into the host's own frame,
/// and is `None` when that relative placement is singular or not finite.
pub(crate) struct RootPlacement {
    pub(crate) root: Matrix4<f64>,
    pub(crate) host: Matrix4<f64>,
    to_host: Option<Matrix4<f64>>,
}

/// The frame one voided host is cut in.
pub(crate) enum CutFrame {
    /// Not chosen yet: the host's first request chooses it.
    Unchosen,
    /// The frame the caller is in.
    Outer,
    /// The root `base` of the host's placement chain, where the finished cut
    /// goes, and the caller's RTC offset.
    Root { base: u32, at: RootPlacement, rtc: (f64, f64, f64) },
}

impl CutFrame {
    /// Choose the frame once. The caller's frame is kept when `own_frame` is
    /// false (the host's geometry arrived placed), when a cut frame is open
    /// already, and when the chain has no root that moves anything: no
    /// placement, an unreadable one, a root that is not an `IfcSite`'s
    /// `IfcLocalPlacement`, one that is the identity or singular, or a host
    /// placement that does not resolve relative to it.
    pub(crate) fn choose(
        &mut self,
        host: &DecodedEntity,
        own_frame: bool,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) {
        if matches!(self, Self::Unchosen) {
            let root = (own_frame && !router.in_cut_frame()).then(|| Self::root_of(host, router, decoder));
            *self = root.flatten().unwrap_or(Self::Outer);
        }
    }

    fn root_of(host: &DecodedEntity, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Option<Self> {
        let placement = decoder.resolve_optional(host, slot::IfcProduct::OBJECT_PLACEMENT.index()).ok()??;
        let base = *placement::chain(&placement, decoder).ok()?.last()?;
        if base.kind != LinkKind::Local {
            return None;
        }
        let base_entity = decoder.decode_by_id(base.id).ok()?;
        let mut root = placement::resolve_chain(&base_entity, decoder).ok()?;
        router.scale_transform(&mut root);
        let moves = root != Matrix4::identity() && root.iter().all(|v| v.is_finite()) && root.try_inverse().is_some();
        // The site lookup reads the source once per model; a root that moves
        // nothing never needs it.
        if !moves || !decoder.is_site_placement(base.id) {
            return None;
        }
        let mut in_root = placement::resolve_chain_relative(&placement, &base_entity, decoder).ok()?;
        router.scale_transform(&mut in_root);
        let to_host = in_root.try_inverse().filter(|m| m.iter().all(|v| v.is_finite()));
        let at = RootPlacement { root, host: root * in_root, to_host };
        Some(Self::Root { base: base.id, at, rtc: router.rtc_offset() })
    }

    /// Open the root frame on `router`, if this host is cut in one.
    pub(crate) fn enter<'r>(&self, router: &'r GeometryRouter) -> Option<CutFrameScope<'r>> {
        match self {
            Self::Root { base, .. } => Some(router.enter_cut_frame(*base)),
            Self::Unchosen | Self::Outer => None,
        }
    }

    /// Give the root frame up when the host's geometry lies beyond
    /// [`crate::LARGE_COORD_THRESHOLD_METERS`] in it: f32 positions that far
    /// out need the model RTC offset, which only the caller's frame applies.
    /// True when the frame was given up, and the host must be walked again.
    pub(crate) fn outgrown_by<'m>(&mut self, mut meshes: impl Iterator<Item = &'m Mesh>) -> bool {
        let far = |mesh: &Mesh| {
            let (min, max) = mesh.bounds();
            let o = mesh.origin;
            crate::coord_is_large((min.x as f64 + o[0], min.y as f64 + o[1], min.z as f64 + o[2]))
                || crate::coord_is_large((max.x as f64 + o[0], max.y as f64 + o[1], max.z as f64 + o[2]))
        };
        let outgrown = matches!(self, Self::Root { .. }) && meshes.any(|mesh| !mesh.is_empty() && far(mesh));
        if outgrown {
            *self = Self::Outer;
        }
        outgrown
    }

    /// The bounds `mesh` has in the caller's frame once placed, for the host
    /// diagnostic. `None` when the mesh is in the caller's frame already.
    pub(crate) fn outer_bounds(&self, mesh: &Mesh) -> Option<((f32, f32, f32), (f32, f32, f32))> {
        let Self::Root { at, rtc, .. } = self else {
            return None;
        };
        let Aabb3 { min, max } = bounds_in(mesh, &at.root);
        let (lo, hi) = ([min[0] - rtc.0, min[1] - rtc.1, min[2] - rtc.2], [max[0] - rtc.0, max[1] - rtc.1, max[2] - rtc.2]);
        Some(((lo[0] as f32, lo[1] as f32, lo[2] as f32), (hi[0] as f32, hi[1] as f32, hi[2] as f32)))
    }

    /// The root and host placements in the caller's frame, handed out once:
    /// the finished cut is placed by them exactly one time, and the host is
    /// in the caller's frame from then on.
    pub(crate) fn take_placement(&mut self) -> Option<RootPlacement> {
        match std::mem::replace(self, Self::Outer) {
            Self::Root { at, .. } => Some(at),
            other => {
                *self = other;
                None
            }
        }
    }
}
