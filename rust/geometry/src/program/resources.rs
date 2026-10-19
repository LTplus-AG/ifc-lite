// SPDX-License-Identifier: MPL-2.0
//! Numerical accumulation in the historical item order. No source service.
use crate::router::frame_parts::{frames_mergeable, mesh_bounds, union_bounds, FrameParts};
use crate::{InstanceMeta, Mesh};

pub(crate) type MergedParts = (Mesh, FrameParts, (Mesh, Option<[f32; 6]>));

#[derive(Default)]
pub(crate) struct MergedResources {
    combined: Mesh,
    rebased: Mesh,
    bounds: Option<[f32; 6]>,
    far: FrameParts,
    rebased_bounds: Option<[f32; 6]>,
    single_instance: Option<InstanceMeta>,
    item_count: usize,
}

impl MergedResources {
    pub(super) fn merge(&mut self, mesh: Mesh, instancing: bool) {
        if mesh.positions.is_empty() { return; }
        let bounds = mesh.local_bounds.unwrap_or_else(|| mesh_bounds(&mesh));
        if instancing {
            self.item_count += 1;
            self.single_instance = if self.item_count == 1 { mesh.instance_meta.clone() } else { None };
        }
        // Raw-coordinate and RTC-applied items cannot merge until placement.
        if mesh.rtc_applied {
            self.rebased.merge(&mesh);
            union_bounds(&mut self.rebased_bounds, bounds);
            return;
        } else if self.combined.positions.is_empty() || frames_mergeable(self.combined.origin, mesh.origin) {
            self.combined.merge(&mesh);
        } else {
            self.far.merge(&mesh, bounds);
            return;
        }
        union_bounds(&mut self.bounds, bounds);
    }

    pub(super) fn finish(mut self, instancing: bool) -> MergedParts {
        if self.combined.positions.is_empty() {
            std::mem::swap(&mut self.combined, &mut self.rebased);
            self.bounds = self.rebased_bounds.take();
        }
        if instancing { self.combined.instance_meta = self.single_instance; }
        self.combined.local_bounds = self.bounds;
        (self.combined, self.far, (self.rebased, self.rebased_bounds))
    }
}
