// SPDX-License-Identifier: MPL-2.0
//! The product walk's numerical accumulation, finish and placement. Nothing
//! here reads source: placement arrives already resolved.
use super::{ProductOutput, Sink};
use crate::router::frame_parts::{frames_mergeable, merge_admitted, mesh_bounds, union_bounds, FrameParts};
use crate::router::processing::SourceHygiene;
use crate::router::transforms::{instancing_enabled, ObjectPlacement};
use crate::{GeometryRouter, InstanceMeta, Mesh, Result, SubMeshCollection};

/// The merged walk's accumulators.
#[derive(Default)]
pub(in crate::program) struct Merged {
    combined: Mesh,
    rebased: Mesh,
    bounds: Option<[f32; 6]>,
    /// #6349: items too far from `combined`'s frame, and the RTC-frame items' own bounds.
    far: FrameParts,
    rebased_bounds: Option<[f32; 6]>,
    /// Instancing: an element is cleanly shareable only when its whole body is
    /// exactly ONE representation item that itself carried instance metadata
    /// (a mapped item). `Mesh::merge` does not propagate the side-channel, so
    /// the single item's metadata is captured here and re-attached at finish;
    /// any second item disqualifies the element (left as None -> rendered flat).
    single_instance_meta: Option<InstanceMeta>,
    instanceable_items: usize,
}

impl Merged {
    /// Merge one item's meshes in order. `false` when a merge was refused,
    /// which ends the walk: the refusal only records the account's sticky
    /// stop, surfaced at finish before hygiene or placement run.
    pub(super) fn merge(&mut self, parts: Vec<Mesh>) -> bool {
        for mesh in parts {
            if mesh.positions.is_empty() {
                continue; // Mesh::merge would ignore it too
            }
            let bounds = mesh.local_bounds.unwrap_or_else(|| mesh_bounds(&mesh));
            if instancing_enabled() {
                self.instanceable_items += 1;
                self.single_instance_meta =
                    if self.instanceable_items == 1 { mesh.instance_meta.clone() } else { None };
            }
            // #5684: early f64 processors and ordinary f32 processors can
            // return different RTC frames. Merge only like frames until
            // placement has brought both into the world/RTC frame.
            if mesh.rtc_applied {
                if !merge_admitted(&mut self.rebased, &mesh) {
                    return false;
                }
                union_bounds(&mut self.rebased_bounds, bounds);
                continue;
            } else if self.combined.positions.is_empty() || frames_mergeable(self.combined.origin, mesh.origin) {
                if !merge_admitted(&mut self.combined, &mesh) {
                    return false;
                }
            } else {
                self.far.merge(&mesh, bounds);
                continue;
            }
            union_bounds(&mut self.bounds, bounds);
        }
        true
    }
}

/// Finished geometry awaiting its placement.
pub(in crate::program) enum Prepared {
    Merged { primary: Mesh, far: FrameParts, rebased: (Mesh, Option<[f32; 6]>), hygiene: SourceHygiene },
    /// An `IfcAlignment`'s axis: placed alone, with no source hygiene.
    Alignment(Mesh),
    Styled(SubMeshCollection),
}

/// Close the accumulators. Source-triangle hygiene runs before placement
/// (rigid transforms preserve degeneracy, while the element-local frame
/// retains more f32 precision). This is the walks' choke point: downstream
/// facet weld / refinement passes canonicalize geometry but do not replace
/// this input cleanup or promise hygienic output. See `SourceHygiene`
/// (#5313); cut-created candidates require path-specific handling (#4797).
pub(super) fn finish(sink: Sink, hygiene: SourceHygiene) -> Result<Prepared> {
    match sink {
        Sink::Merged(mut merged) => {
            // A refused merge only records the account's sticky stop; surface it
            // before hygiene or placement run over partial output.
            if crate::resource::is_active() {
                crate::resource::check_current()?;
            }
            if merged.combined.positions.is_empty() {
                std::mem::swap(&mut merged.combined, &mut merged.rebased);
                merged.bounds = merged.rebased_bounds.take();
            }
            // Re-attach single-item instance metadata so placement can fold the
            // element's world placement into `transform`.
            if instancing_enabled() {
                merged.combined.instance_meta = merged.single_instance_meta;
            }
            merged.combined.local_bounds = merged.bounds;
            hygiene.apply(&mut merged.combined);
            Ok(Prepared::Merged {
                primary: merged.combined,
                far: merged.far,
                rebased: (merged.rebased, merged.rebased_bounds),
                hygiene,
            })
        }
        Sink::Styled(mut sub_meshes) => {
            // Positions are never removed, so unreferenced ones may remain. A
            // textured sub-mesh stays `IndexOnly` because an appended apex
            // vertex would desynchronise its parallel UV array. The layered
            // early-return channel cleans at its own site (#5313).
            for sub in &mut sub_meshes.sub_meshes {
                let own = if sub.uvs.is_some() { SourceHygiene::IndexOnly } else { hygiene };
                own.apply(&mut sub.mesh);
            }
            Ok(Prepared::Styled(sub_meshes))
        }
    }
}

impl Prepared {
    /// Place the finished geometry by the product's resolved placement.
    pub(super) fn place(self, placement: &ObjectPlacement, router: &GeometryRouter) -> Result<ProductOutput> {
        match self {
            Self::Merged { mut primary, far, rebased, hygiene } => {
                router.place_mesh(&mut primary, placement);
                router.place_frame_parts(placement, hygiene, primary, far, rebased).map(ProductOutput::Parts)
            }
            Self::Alignment(mut mesh) => {
                router.place_mesh(&mut mesh, placement);
                Ok(ProductOutput::Parts(vec![mesh]))
            }
            Self::Styled(mut sub_meshes) => {
                router.place_sub_meshes(&mut sub_meshes, placement);
                Ok(ProductOutput::Styled(sub_meshes))
            }
        }
    }
}
