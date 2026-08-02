// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material Layer Index
//!
//! Maps building elements to the material buildup that lets us slice their
//! single swept-solid mesh into per-layer sub-meshes (e.g. a wall's core,
//! insulation, and finish showing up as separately coloured slabs).
//!
//! The index scans `IfcRelAssociatesMaterial` once per file and resolves each
//! element to a [`LayerBuildup`] when the associated material is a
//! [`IfcMaterialLayerSetUsage`] pointing at a plain
//! [`IfcMaterialLayerSet`]. Other material representations (single
//! `IfcMaterial`, `IfcMaterialConstituentSet`, `IfcMaterialProfileSet`,
//! legacy `IfcMaterialList`, or layer sets with per-layer offsets used for
//! tapered walls) do not map to a set of planar cutting planes and are
//! recorded as [`LayerBuildup::NotSliceable`] so the caller can fall back
//! to its existing path.

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use rustc_hash::FxHashMap;

/// Which local axis the material layers stack along.
///
/// Mirrors `IfcLayerSetDirectionEnum` in the spec:
/// <https://standards.buildingsmart.org/IFC/RELEASE/IFC4_ADD2_TC1/HTML/schema/ifcmaterialresource/lexical/ifclayersetdirectionenum.htm>
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerAxis {
    /// Along local +X (rare for walls; used when the wall's "layers" run
    /// along its length, e.g. horizontal segmentation).
    Axis1,
    /// Along local +Y — walls (thickness direction).
    Axis2,
    /// Along local +Z — slabs, roofs, coverings (through-depth).
    Axis3,
}

impl LayerAxis {
    /// Return the unit vector of this axis in the element's local frame.
    pub fn unit_vector(self) -> [f64; 3] {
        match self {
            LayerAxis::Axis1 => [1.0, 0.0, 0.0],
            LayerAxis::Axis2 => [0.0, 1.0, 0.0],
            LayerAxis::Axis3 => [0.0, 0.0, 1.0],
        }
    }
}

/// One layer in a [`LayerBuildup`].
///
/// `material_id` is the express ID of the associated `IfcMaterial`, or `0`
/// when the layer has no material reference (valid per spec — represents an
/// air gap / ventilated cavity).
#[derive(Debug, Clone, PartialEq)]
pub struct LayerInfo {
    /// `IfcMaterial` entity ID for color lookup. Zero means no material.
    pub material_id: u32,
    /// Layer thickness in the project's length unit (same unit as the IFC
    /// file). The caller is responsible for applying the project unit scale
    /// when mapping to world coordinates.
    pub thickness: f64,
}

/// Layer buildup resolved for one element.
///
/// `Sliceable` carries everything needed to produce N-1 cutting planes in
/// the element's local frame and color each slice by its material.
/// `NotSliceable` is emitted when we identified a material association but
/// it doesn't map cleanly to planar slicing (constituents, single material,
/// profile set, tapered with offsets, etc.) — callers should fall back to
/// the existing mesh path and apply a uniform element-level colour.
#[derive(Debug, Clone, PartialEq)]
pub enum LayerBuildup {
    Sliceable {
        /// Layers in the order they appear in `IfcMaterialLayerSet.MaterialLayers`.
        layers: Vec<LayerInfo>,
        /// Which local axis the layers stack along.
        axis: LayerAxis,
        /// `+1.0` for `POSITIVE`, `-1.0` for `NEGATIVE`.
        direction_sense: f64,
        /// Signed distance from the element's reference line to the start
        /// face of the first layer, in the project's length unit.
        offset_from_reference_line: f64,
    },
    NotSliceable,
}

impl LayerBuildup {
    pub fn is_sliceable(&self) -> bool {
        matches!(self, LayerBuildup::Sliceable { .. })
    }
}

/// Map from element entity ID to its resolved [`LayerBuildup`].
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MaterialLayerIndex {
    element_to_buildup: FxHashMap<u32, LayerBuildup>,
}

/// Flat, wire-friendly encoding of a [`MaterialLayerIndex`], produced by
/// [`MaterialLayerIndex::to_flat`] and reconstructed by
/// [`MaterialLayerIndex::from_flat`].
///
/// The streaming pre-pass builds the index ONCE (from the `IfcRelAssociatesMaterial`
/// spans it already collected) and ships this encoding to every geometry worker,
/// so each worker's first `processGeometryBatch` skips the per-worker
/// [`MaterialLayerIndex::from_content`] full-file decode scan. All fields are
/// SoA parallel arrays so they cross the wasm/JS boundary as plain typed arrays:
///
/// * `element_ids[i]` — the element express id of record `i`.
/// * `axis[i]` — `0` = `NotSliceable`; `1`/`2`/`3` = sliceable along `Axis1`/`Axis2`/`Axis3`.
/// * `layer_counts[i]` — number of layers of record `i` (`0` for `NotSliceable`).
/// * `direction_sense[i]`, `offset[i]` — the sliceable scalars (`0.0` for `NotSliceable`).
/// * `layer_material_ids` / `layer_thicknesses` — per-layer values, concatenated in
///   record order; record `i` consumes `layer_counts[i]` entries starting after the
///   layers of every earlier record.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MaterialLayerFlat {
    pub element_ids: Vec<u32>,
    pub axis: Vec<u32>,
    pub layer_counts: Vec<u32>,
    pub direction_sense: Vec<f64>,
    pub offset: Vec<f64>,
    pub layer_material_ids: Vec<u32>,
    pub layer_thicknesses: Vec<f64>,
}

impl MaterialLayerIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan `content` for `IfcRelAssociatesMaterial` and build the index.
    ///
    /// One pass over the file: for each association we resolve the
    /// `RelatingMaterial` once and insert the result under every related
    /// object ID. Elements that associate with a non-sliceable material are
    /// still inserted (as `NotSliceable`) so callers can distinguish
    /// "has a material, can't slice" from "no material association at all".
    pub fn from_content<T>(content: &T, decoder: &mut EntityDecoder) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let content = content.as_ref();
        let mut index = Self::new();
        let mut scanner = EntityScanner::new(content);

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name != "IFCRELASSOCIATESMATERIAL" {
                continue;
            }
            index.insert_association(id, start, end, decoder);
        }

        index
    }

    /// Build the index from PRE-COLLECTED `IfcRelAssociatesMaterial` spans
    /// instead of re-walking the file. The streaming pre-pass already stashes
    /// every association span during its single scan, so it builds the index
    /// once here and ships it to the workers (each of which would otherwise
    /// re-run [`Self::from_content`]'s full-file scan on its first batch).
    ///
    /// Byte-identical to [`Self::from_content`] on the same file: both feed the
    /// exact same spans, in the exact same file order, through the shared
    /// [`Self::insert_association`] step (whose only order-sensitivity — "prefer
    /// Sliceable, never overwrite it with NotSliceable" — is preserved because
    /// the pre-pass collects spans in scan order). `spans` are `(id, start, end)`.
    pub fn from_spans(spans: &[(u32, usize, usize)], decoder: &mut EntityDecoder) -> Self {
        let mut index = Self::new();
        for &(id, start, end) in spans {
            index.insert_association(id, start, end, decoder);
        }
        index
    }

    /// Resolve one `IfcRelAssociatesMaterial` span and fold it into the index.
    /// Shared by [`Self::from_content`] (scanner-driven) and [`Self::from_spans`]
    /// (span-driven) so the two paths cannot drift.
    fn insert_association(
        &mut self,
        id: u32,
        start: usize,
        end: usize,
        decoder: &mut EntityDecoder,
    ) {
        let entity = match decoder.decode_at_with_id(id, start, end) {
            Ok(e) => e,
            Err(_) => return,
        };

        // IfcRelAssociatesMaterial:
        //   4: RelatedObjects (list)
        //   5: RelatingMaterial (IfcMaterialSelect ref)
        let relating_id = match entity.get_ref(5) {
            Some(id) => id,
            None => return,
        };
        let related_attr = match entity.get(4) {
            Some(a) => a,
            None => return,
        };
        let related_ids: Vec<u32> = match related_attr.as_list() {
            Some(list) => list.iter().filter_map(|v| v.as_entity_ref()).collect(),
            None => return,
        };
        if related_ids.is_empty() {
            return;
        }

        let buildup = resolve_buildup(relating_id, decoder);
        for obj_id in related_ids {
            // The same element may be associated twice (once via element,
            // once via its type). Prefer the Sliceable entry if we see
            // one; never overwrite Sliceable with NotSliceable.
            match self.element_to_buildup.get(&obj_id) {
                Some(LayerBuildup::Sliceable { .. }) => continue,
                _ => {
                    self.element_to_buildup.insert(obj_id, buildup.clone());
                }
            }
        }
    }

    /// Serialize the index into a flat [`MaterialLayerFlat`] for the wire.
    /// Round-trips exactly through [`Self::from_flat`] (proven in this module's
    /// tests): `from_flat(idx.to_flat()) == idx` for every index.
    pub fn to_flat(&self) -> MaterialLayerFlat {
        let mut flat = MaterialLayerFlat::default();
        for (&element_id, buildup) in &self.element_to_buildup {
            flat.element_ids.push(element_id);
            match buildup {
                LayerBuildup::NotSliceable => {
                    flat.axis.push(0);
                    flat.layer_counts.push(0);
                    flat.direction_sense.push(0.0);
                    flat.offset.push(0.0);
                }
                LayerBuildup::Sliceable {
                    layers,
                    axis,
                    direction_sense,
                    offset_from_reference_line,
                } => {
                    flat.axis.push(match axis {
                        LayerAxis::Axis1 => 1,
                        LayerAxis::Axis2 => 2,
                        LayerAxis::Axis3 => 3,
                    });
                    flat.layer_counts.push(layers.len() as u32);
                    flat.direction_sense.push(*direction_sense);
                    flat.offset.push(*offset_from_reference_line);
                    for layer in layers {
                        flat.layer_material_ids.push(layer.material_id);
                        flat.layer_thicknesses.push(layer.thickness);
                    }
                }
            }
        }
        flat
    }

    /// Reconstruct an index from the flat SoA arrays produced by
    /// [`Self::to_flat`]. Defensive against short/misaligned inputs (a
    /// truncated wire buffer stops early rather than panicking), but on
    /// well-formed input it is the exact inverse of `to_flat`.
    #[allow(clippy::too_many_arguments)]
    pub fn from_flat(
        element_ids: &[u32],
        axis: &[u32],
        layer_counts: &[u32],
        direction_sense: &[f64],
        offset: &[f64],
        layer_material_ids: &[u32],
        layer_thicknesses: &[f64],
    ) -> Self {
        let mut index = Self::new();
        let n = element_ids.len();
        // Every per-record array must be at least as long as element_ids;
        // bail on a malformed buffer instead of indexing out of bounds.
        if axis.len() < n
            || layer_counts.len() < n
            || direction_sense.len() < n
            || offset.len() < n
        {
            return index;
        }
        let mut cursor = 0usize;
        for i in 0..n {
            let count = layer_counts[i] as usize;
            let buildup = if axis[i] == 0 {
                LayerBuildup::NotSliceable
            } else {
                if cursor + count > layer_material_ids.len()
                    || cursor + count > layer_thicknesses.len()
                {
                    return index;
                }
                let mut layers = Vec::with_capacity(count);
                for k in 0..count {
                    layers.push(LayerInfo {
                        material_id: layer_material_ids[cursor + k],
                        thickness: layer_thicknesses[cursor + k],
                    });
                }
                LayerBuildup::Sliceable {
                    layers,
                    axis: match axis[i] {
                        1 => LayerAxis::Axis1,
                        3 => LayerAxis::Axis3,
                        // 2 (and any stray value) map to Axis2, the wall default.
                        _ => LayerAxis::Axis2,
                    },
                    direction_sense: direction_sense[i],
                    offset_from_reference_line: offset[i],
                }
            };
            cursor += count;
            index.element_to_buildup.insert(element_ids[i], buildup);
        }
        index
    }

    /// Get the resolved buildup for an element, or `None` if the element
    /// has no material association at all.
    pub fn get(&self, element_id: u32) -> Option<&LayerBuildup> {
        self.element_to_buildup.get(&element_id)
    }

    /// Returns `true` when the element has a recorded buildup that is
    /// `LayerBuildup::Sliceable` — i.e. its single swept solid can be cut
    /// into per-layer slabs.
    ///
    /// Used by the wasm-bindings layer to decide whether an aggregated
    /// `IfcWall` parent already produces per-layer sub-meshes (so its
    /// `IfcBuildingElementPart` children can be skipped when the
    /// merge-layers toggle is on — see issue #540).
    pub fn is_sliceable(&self, element_id: u32) -> bool {
        matches!(
            self.element_to_buildup.get(&element_id),
            Some(LayerBuildup::Sliceable { .. })
        )
    }

    /// Number of elements with a recorded buildup (sliceable or not).
    pub fn len(&self) -> usize {
        self.element_to_buildup.len()
    }

    pub fn is_empty(&self) -> bool {
        self.element_to_buildup.is_empty()
    }

    /// Count how many of the recorded buildups are actually sliceable.
    /// Useful for logging / statistics — not on the hot path.
    pub fn sliceable_count(&self) -> usize {
        self.element_to_buildup
            .values()
            .filter(|b| b.is_sliceable())
            .count()
    }
}

/// Resolve an `IfcMaterialSelect` ID into a [`LayerBuildup`].
///
/// Follows the one path that maps to planar cutting: `LayerSetUsage ->
/// LayerSet -> Layers`. Anything else is `NotSliceable`.
fn resolve_buildup(material_select_id: u32, decoder: &mut EntityDecoder) -> LayerBuildup {
    let entity = match decoder.decode_by_id(material_select_id) {
        Ok(e) => e,
        Err(_) => return LayerBuildup::NotSliceable,
    };

    match entity.ifc_type {
        IfcType::IfcMaterialLayerSetUsage => resolve_layer_set_usage(&entity, decoder),
        // All other material representations either carry no geometry
        // (IfcMaterial, IfcMaterialList, IfcMaterialConstituentSet) or
        // describe cross-section rather than layers (IfcMaterialProfileSet,
        // IfcMaterialProfileSetUsage). Caller falls back to uniform colour.
        _ => LayerBuildup::NotSliceable,
    }
}

/// Decode an `IfcMaterialLayerSetUsage` into a sliceable buildup.
///
/// Attribute layout
/// (<https://standards.buildingsmart.org/IFC/RELEASE/IFC4_ADD2_TC1/HTML/schema/ifcproductextension/lexical/ifcmateriallayersetusage.htm>):
///   0: ForLayerSet (ref IfcMaterialLayerSet)
///   1: LayerSetDirection (IfcLayerSetDirectionEnum)
///   2: DirectionSense (IfcDirectionSenseEnum)
///   3: OffsetFromReferenceLine (IfcLengthMeasure)
fn resolve_layer_set_usage(usage: &DecodedEntity, decoder: &mut EntityDecoder) -> LayerBuildup {
    let layer_set_id = match usage.get_ref(0) {
        Some(id) => id,
        None => return LayerBuildup::NotSliceable,
    };
    let axis = match usage
        .get(1)
        .and_then(|a| a.as_enum())
        .map(str::to_ascii_uppercase)
    {
        Some(s) if s == "AXIS1" => LayerAxis::Axis1,
        Some(s) if s == "AXIS2" => LayerAxis::Axis2,
        Some(s) if s == "AXIS3" => LayerAxis::Axis3,
        // Missing or unrecognised → walls default to AXIS2 per spec, but
        // rather than guess, treat as unsliceable.
        _ => return LayerBuildup::NotSliceable,
    };
    let direction_sense = match usage
        .get(2)
        .and_then(|a| a.as_enum())
        .map(str::to_ascii_uppercase)
    {
        Some(s) if s == "POSITIVE" => 1.0_f64,
        Some(s) if s == "NEGATIVE" => -1.0_f64,
        _ => return LayerBuildup::NotSliceable,
    };
    let offset = usage.get_float(3).unwrap_or(0.0);

    let layer_set_entity = match decoder.decode_by_id(layer_set_id) {
        Ok(e) => e,
        Err(_) => return LayerBuildup::NotSliceable,
    };
    if layer_set_entity.ifc_type != IfcType::IfcMaterialLayerSet {
        return LayerBuildup::NotSliceable;
    }

    // IfcMaterialLayerSet.MaterialLayers at attr 0
    let layer_ids: Vec<u32> = match layer_set_entity.get(0).and_then(|a| a.as_list()) {
        Some(list) => list.iter().filter_map(|v| v.as_entity_ref()).collect(),
        None => return LayerBuildup::NotSliceable,
    };
    if layer_ids.is_empty() {
        return LayerBuildup::NotSliceable;
    }

    let mut layers = Vec::with_capacity(layer_ids.len());
    for layer_id in &layer_ids {
        let layer = match decoder.decode_by_id(*layer_id) {
            Ok(e) => e,
            Err(_) => return LayerBuildup::NotSliceable,
        };
        // Tapered walls use IfcMaterialLayerWithOffsets (subtype of
        // IfcMaterialLayer). The interface between such layers is a ruled
        // surface, not a plane — bail to uniform fallback.
        if layer.ifc_type != IfcType::IfcMaterialLayer {
            return LayerBuildup::NotSliceable;
        }
        // IfcMaterialLayer:
        //   0: Material (IfcMaterial ref, OPTIONAL)
        //   1: LayerThickness (IfcPositiveLengthMeasure)
        let material_id = layer.get_ref(0).unwrap_or(0);
        let thickness = layer.get_float(1).unwrap_or(0.0);
        if !thickness.is_finite() || thickness <= 0.0 {
            // Spec forbids zero/negative thickness but malformed files exist.
            // Skip the layer rather than the whole buildup.
            continue;
        }
        layers.push(LayerInfo {
            material_id,
            thickness,
        });
    }

    if layers.len() < 2 {
        // A single-layer wall doesn't need slicing — uniform fallback is fine.
        return LayerBuildup::NotSliceable;
    }

    LayerBuildup::Sliceable {
        layers,
        axis,
        direction_sense,
        offset_from_reference_line: offset,
    }
}

#[cfg(test)]
mod flat_roundtrip_tests {
    use super::*;

    fn sample_index() -> MaterialLayerIndex {
        let mut index = MaterialLayerIndex::new();
        // A three-layer sliceable wall (Axis2, POSITIVE, offset -0.15).
        index.element_to_buildup.insert(
            100,
            LayerBuildup::Sliceable {
                layers: vec![
                    LayerInfo { material_id: 200, thickness: 0.05 },
                    LayerInfo { material_id: 201, thickness: 0.2 },
                    LayerInfo { material_id: 200, thickness: 0.05 },
                ],
                axis: LayerAxis::Axis2,
                direction_sense: 1.0,
                offset_from_reference_line: -0.15,
            },
        );
        // A two-layer slab along Axis3, NEGATIVE, with a zero-material air gap.
        index.element_to_buildup.insert(
            101,
            LayerBuildup::Sliceable {
                layers: vec![
                    LayerInfo { material_id: 0, thickness: 0.1 },
                    LayerInfo { material_id: 300, thickness: 0.25 },
                ],
                axis: LayerAxis::Axis3,
                direction_sense: -1.0,
                offset_from_reference_line: 0.0,
            },
        );
        // A NotSliceable association (single material / constituent set).
        index
            .element_to_buildup
            .insert(102, LayerBuildup::NotSliceable);
        index
    }

    #[test]
    fn to_flat_from_flat_is_identity() {
        let index = sample_index();
        let flat = index.to_flat();
        let restored = MaterialLayerIndex::from_flat(
            &flat.element_ids,
            &flat.axis,
            &flat.layer_counts,
            &flat.direction_sense,
            &flat.offset,
            &flat.layer_material_ids,
            &flat.layer_thicknesses,
        );
        assert_eq!(
            index, restored,
            "flat round-trip must reproduce the index bit-for-bit"
        );
    }

    #[test]
    fn empty_index_round_trips_to_empty() {
        let index = MaterialLayerIndex::new();
        let flat = index.to_flat();
        assert!(flat.element_ids.is_empty());
        let restored = MaterialLayerIndex::from_flat(
            &flat.element_ids,
            &flat.axis,
            &flat.layer_counts,
            &flat.direction_sense,
            &flat.offset,
            &flat.layer_material_ids,
            &flat.layer_thicknesses,
        );
        assert_eq!(index, restored);
        assert!(restored.is_empty());
    }

    #[test]
    fn from_flat_bails_on_truncated_buffer() {
        // element_ids says one record but the per-record arrays are empty:
        // reconstruction must stop cleanly, not panic or index OOB.
        let restored = MaterialLayerIndex::from_flat(&[100], &[], &[], &[], &[], &[], &[]);
        assert!(restored.is_empty());
    }
}
