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
//! The root of a host's placement chain (the site's placement, in an ordinary
//! file) is the rigid placement of the whole model. While a
//! [`CutFrameScope`] is open, every placement the router resolves is
//! expressed relative to that root and the model RTC offset reads as zero, so
//! the host, its openings and the whole cut see what they would see with the
//! root at the origin. The void program then places the finished cut by the
//! root placement, and the RTC shift with it.
//!
//! Relative placements come from [`placement::resolve_chain_relative`], which
//! composes only the links below the root: the root's own numbers never enter
//! the cut. A chain whose root is the identity is in this frame already and
//! keeps the caller's.

use super::GeometryRouter;
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

    /// Place a mesh cut in a root frame into the caller's frame: `root` is the
    /// root placement and `host` the host's whole placement, both in metres.
    /// Runs with the cut frame closed, so the world step sees the caller's
    /// RTC offset.
    ///
    /// The cut is welded first, for the reason [`Self::place_mesh`] gives:
    /// the weld keys on f32 bits, so welding the placed result would make the
    /// vertex buffer depend on where the model sits (#4103).
    pub(crate) fn place_root_frame_cut(&self, mesh: &mut Mesh, root: &Matrix4<f64>, host: &Matrix4<f64>) {
        crate::mesh_weld::weld_mesh(mesh);
        self.bake_root_frame_cut(mesh, root, host);
    }

    /// [`Self::place_root_frame_cut`] for a sub-mesh, carrying its UVs.
    pub(crate) fn place_root_frame_cut_sub(
        &self,
        sub: &mut crate::SubMesh,
        root: &Matrix4<f64>,
        host: &Matrix4<f64>,
    ) {
        crate::mesh_weld::weld_sub_mesh(sub);
        self.bake_root_frame_cut(&mut sub.mesh, root, host);
    }

    fn bake_root_frame_cut(&self, mesh: &mut Mesh, root: &Matrix4<f64>, host: &Matrix4<f64>) {
        debug_assert!(!self.in_cut_frame(), "a root-frame cut is placed with its frame closed");
        let host = mat4::from_na(host);
        if let Some(meta) = mesh.instance_meta.as_mut() {
            meta.transform = host;
        }
        self.transform_mesh_world(mesh, root);
        // The object-frame bounds were captured when the host was placed in
        // the root frame; their transform is the host's whole placement (#1474).
        mesh.local_to_world = Some(host);
    }
}

/// The frame one voided host is cut in.
pub(crate) enum CutFrame {
    /// Not chosen yet: the host's first request chooses it.
    Unchosen,
    /// The frame the caller is in.
    Outer,
    /// The root `base` of the host's placement chain. `root` is that
    /// placement and `host` the host's whole placement, both in the caller's
    /// frame and in metres; `rtc` is the caller's RTC offset.
    Root { base: u32, root: Matrix4<f64>, host: Matrix4<f64>, rtc: (f64, f64, f64), placed: bool },
}

impl CutFrame {
    /// Choose the frame once. The caller's frame is kept when `own_frame` is
    /// false (the host's geometry arrived placed), when a cut frame is open
    /// already, and when the chain has no root that moves anything: no
    /// placement, an unreadable one, a root that is not an
    /// `IfcLocalPlacement`, or one that is the identity or singular.
    pub(crate) fn choose(
        &mut self,
        host: &DecodedEntity,
        own_frame: bool,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) {
        if matches!(self, Self::Unchosen) {
            *self = Self::root_of(host, router, decoder)
                .filter(|_| own_frame && !router.in_cut_frame())
                .unwrap_or(Self::Outer);
        }
    }

    fn root_of(host: &DecodedEntity, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Option<Self> {
        let placement = decoder.resolve_optional(host, slot::IfcProduct::OBJECT_PLACEMENT.index()).ok()??;
        let base = *placement::chain(&placement, decoder).ok()?.last()?;
        if base.kind != LinkKind::Local {
            return None;
        }
        let mut root = placement::resolve_chain(&decoder.decode_by_id(base.id).ok()?, decoder).ok()?;
        router.scale_transform(&mut root);
        let host = router.resolve_object_placement(host, decoder).ok()?.transform;
        let moves = root != Matrix4::identity() && root.iter().all(|v| v.is_finite()) && root.try_inverse().is_some();
        moves.then(|| Self::Root { base: base.id, root, host, rtc: router.rtc_offset(), placed: false })
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
        let Self::Root { root, rtc, .. } = self else {
            return None;
        };
        let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for chunk in mesh.positions.chunks_exact(3) {
            let point = root.transform_point(&nalgebra::Point3::new(
                chunk[0] as f64 + mesh.origin[0],
                chunk[1] as f64 + mesh.origin[1],
                chunk[2] as f64 + mesh.origin[2],
            ));
            for (axis, value) in [point.x - rtc.0, point.y - rtc.1, point.z - rtc.2].into_iter().enumerate() {
                min[axis] = min[axis].min(value);
                max[axis] = max[axis].max(value);
            }
        }
        Some(((min[0] as f32, min[1] as f32, min[2] as f32), (max[0] as f32, max[1] as f32, max[2] as f32)))
    }

    /// The root and host placements in the caller's frame, handed out once:
    /// the finished cut is placed by them exactly one time.
    pub(crate) fn take_placement(&mut self) -> Option<(Matrix4<f64>, Matrix4<f64>)> {
        match self {
            Self::Root { root, host, placed: placed @ false, .. } => {
                *placed = true;
                Some((*root, *host))
            }
            _ => None,
        }
    }
}
