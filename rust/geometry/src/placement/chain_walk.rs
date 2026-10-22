// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The climb up `PlacementRelTo`: one parent per placement, so the walk is a
//! loop with a visited set and no depth cap (D27, `AGENTS.md` "Bounding walks").

use super::chain::LinkKind;
use super::grid_frame::{owning_grid_frame, GridPlacementLayout, OwningFrame};
use super::{PlacementError, PlacementResult};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;
use smallvec::SmallVec;

/// Paths this short are checked by scanning; longer ones switch to a hash set
/// so an adversarial chain costs O(n), not O(n²).
const SCAN_LIMIT: usize = 16;

/// The `IfcGridPlacement` slots read at climb time.
pub(super) struct GridCtx {
    pub(super) layout: GridPlacementLayout,
    pub(super) location: Option<DecodedEntity>,
}

/// One placement on the path, leaf first. Kept small: frames are pushed and
/// dropped once per placement read, and the grid slots (rare) are boxed.
pub(super) struct Frame {
    pub(super) entity: DecodedEntity,
    pub(super) kind: LinkKind,
    pub(super) grid: Option<Box<GridCtx>>,
    /// The owning-grid axis id whose memo entry holds this frame's parent world.
    pub(super) alias: Option<u32>,
}

/// The result of a climb, filled in place so the frames are never moved out
/// of the caller's stack (the climb runs once per memo miss, on the hot path).
pub(super) struct Climb {
    pub(super) frames: SmallVec<[Frame; 8]>,
    /// World transform of the placement above the last frame (identity at a root).
    pub(super) base: Matrix4<f64>,
    /// The record that ended the climb because it is not a placement.
    pub(super) stopped_at: Option<(u32, IfcType)>,
}

impl Climb {
    pub(super) fn new() -> Self {
        Self { frames: SmallVec::new(), base: Matrix4::identity(), stopped_at: None }
    }
}

fn kind_of(ifc_type: &IfcType) -> Option<LinkKind> {
    match *ifc_type {
        IfcType::IfcLocalPlacement => Some(LinkKind::Local),
        IfcType::IfcLinearPlacement => Some(LinkKind::Linear),
        IfcType::IfcGridPlacement => Some(LinkKind::Grid),
        _ => None,
    }
}

struct Seen(Option<FxHashSet<u32>>);

impl Seen {
    fn first_visit(&mut self, id: u32, frames: &[Frame]) -> bool {
        if let Some(set) = &mut self.0 {
            return set.insert(id);
        }
        if frames.iter().any(|f| f.entity.id == id) {
            return false;
        }
        if frames.len() >= SCAN_LIMIT {
            let mut set: FxHashSet<u32> = frames.iter().map(|f| f.entity.id).collect();
            set.insert(id);
            self.0 = Some(set);
        }
        true
    }
}

fn cyclic(decoder: &EntityDecoder, at: u32) -> PlacementError {
    let _counted = decoder.refuse_malformed(at);
    PlacementError::Cyclic { at }
}

fn rel_to(placement: &DecodedEntity, slot: usize, decoder: &mut EntityDecoder) -> PlacementResult<Option<DecodedEntity>> {
    Ok(decoder.resolve_optional(placement, slot)?)
}

/// Climb from `first` to the root into `out`. With `memo`, a memoised ancestor
/// ends the climb and supplies `out.base`; without it the whole path is
/// collected. `first_checked` says the caller already looked `first` up.
pub(super) fn climb(
    out: &mut Climb,
    first: &DecodedEntity,
    decoder: &mut EntityDecoder,
    memo: bool,
    first_checked: bool,
) -> PlacementResult<()> {
    let mut seen = Seen(None);
    let mut current = first.clone();
    let mut skip_lookup = first_checked;
    loop {
        if memo && !skip_lookup {
            if let Some(m) = decoder.get_placement_transform_cached(current.id) {
                out.base = Matrix4::from_column_slice(&m);
                break;
            }
        }
        skip_lookup = false;
        let Some(kind) = kind_of(&current.ifc_type) else {
            out.stopped_at = Some((current.id, current.ifc_type.clone()));
            break;
        };
        if !seen.first_visit(current.id, &out.frames) {
            return Err(cyclic(decoder, current.id));
        }
        let mut grid = None;
        let mut alias = None;
        let parent = match kind {
            LinkKind::Local | LinkKind::Linear => rel_to(&current, slot::IfcObjectPlacement::PLACEMENT_REL_TO.index(), decoder)?,
            LinkKind::Grid => {
                let layout = GridPlacementLayout::of(decoder);
                let location = match layout.location {
                    Some(i) => decoder.resolve_optional(&current, i)?,
                    None => None,
                }.filter(|loc| loc.ifc_type == IfcType::IfcVirtualGridIntersection);
                let parent = match layout.rel_to {
                    Some(i) => rel_to(&current, i, decoder)?,
                    None => match location.as_ref().map(|loc| owning_grid_frame(loc, decoder)) {
                        None | Some(Ok(OwningFrame::Identity)) => None,
                        Some(Ok(OwningFrame::Cached(m))) => {
                            out.base = m;
                            None
                        }
                        Some(Ok(OwningFrame::Walk { parent, axis_id })) => {
                            alias = Some(axis_id);
                            parent
                        }
                        Some(Err(e)) => return Err(e),
                    },
                };
                grid = Some(Box::new(GridCtx { layout, location }));
                parent
            }
        };
        out.frames.push(Frame { entity: current, kind, grid, alias });
        match parent {
            Some(p) => current = p,
            None => break,
        }
    }
    Ok(())
}
