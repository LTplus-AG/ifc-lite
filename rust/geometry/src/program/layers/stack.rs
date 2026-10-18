// SPDX-License-Identifier: MPL-2.0
//! Owned visual layer stack and original thin-layer merge policy.
use crate::material_layer_index::LayerInfo;

const MIN_SLICEABLE_THICKNESS_M: f64 = 0.002;

/// A collapsed view of the layer stack after merging sub-mm layers into
/// their thick neighbours. Each entry represents one slab that will be
/// emitted as a sub-mesh.
#[derive(Debug, Clone)]
pub(super) struct VisualLayer {
    /// `IfcMaterial` id that colours the slab. Taken from the dominant
    /// (thickest) source layer in the merge group so thin vapour barriers
    /// don't hijack the slab's colour.
    pub(super) material_id: u32,
    /// Total thickness of the slab in meters (sum of merged source layers).
    pub(super) thickness_m: f64,
}

/// Fold sub-mm layers into an adjacent visible layer so every emitted
/// cutting plane sits on a real interface between two slabs that are
/// both thick enough for stable clipping.
///
/// Strategy: start with one slab per source layer. Repeatedly pick the
/// thinnest slab that is still below the clip-stable threshold and fold
/// its thickness into the thicker of its two neighbours (the thicker
/// neighbour's material wins because it dominates the merged slab's
/// appearance). Stops once every slab is above threshold or only one slab
/// remains.
pub(super) fn merge_thin_layers(layers: &[LayerInfo], unit_scale: f64) -> Vec<VisualLayer> {
    let thresh = MIN_SLICEABLE_THICKNESS_M;
    let mut slabs: Vec<VisualLayer> = layers
        .iter()
        .map(|l| VisualLayer {
            material_id: l.material_id,
            thickness_m: l.thickness * unit_scale,
        })
        .collect();

    loop {
        if slabs.len() <= 1 {
            break;
        }
        // Find the thinnest sub-threshold slab.
        let mut victim: Option<usize> = None;
        let mut victim_thickness = thresh;
        for (i, s) in slabs.iter().enumerate() {
            if s.thickness_m < victim_thickness {
                victim = Some(i);
                victim_thickness = s.thickness_m;
            }
        }
        let Some(v) = victim else { break };

        // Fold into the thicker neighbour; its material dominates the slab.
        let prev = if v > 0 { Some(v - 1) } else { None };
        let next = if v + 1 < slabs.len() {
            Some(v + 1)
        } else {
            None
        };
        let target = match (prev, next) {
            (Some(p), Some(n)) => {
                if slabs[p].thickness_m >= slabs[n].thickness_m {
                    p
                } else {
                    n
                }
            }
            (Some(p), None) => p,
            (None, Some(n)) => n,
            (None, None) => break,
        };
        slabs[target].thickness_m += slabs[v].thickness_m;
        // Adjust target index when removing a slab that preceded it.
        slabs.remove(v);
    }

    slabs
}
