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
#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
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
#[derive(Debug, Default, Clone)]
pub struct MaterialLayerIndex {
    element_to_buildup: FxHashMap<u32, LayerBuildup>,
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
    pub fn from_content(content: &str, decoder: &mut EntityDecoder) -> Self {
        let mut index = Self::new();
        let mut scanner = EntityScanner::new(content);

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name != "IFCRELASSOCIATESMATERIAL" {
                continue;
            }
            let entity = match decoder.decode_at_with_id(id, start, end) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // IfcRelAssociatesMaterial:
            //   4: RelatedObjects (list)
            //   5: RelatingMaterial (IfcMaterialSelect ref)
            let relating_id = match entity.get_ref(5) {
                Some(id) => id,
                None => continue,
            };
            let related_attr = match entity.get(4) {
                Some(a) => a,
                None => continue,
            };
            let related_ids: Vec<u32> = match related_attr.as_list() {
                Some(list) => list.iter().filter_map(|v| v.as_entity_ref()).collect(),
                None => continue,
            };
            if related_ids.is_empty() {
                continue;
            }

            let buildup = resolve_buildup(relating_id, decoder);
            for obj_id in related_ids {
                // The same element may be associated twice (once via element,
                // once via its type). Prefer the Sliceable entry if we see
                // one; never overwrite Sliceable with NotSliceable.
                match index.element_to_buildup.get(&obj_id) {
                    Some(LayerBuildup::Sliceable { .. }) => continue,
                    _ => {
                        index.element_to_buildup.insert(obj_id, buildup.clone());
                    }
                }
            }
        }

        index
    }

    /// Get the resolved buildup for an element, or `None` if the element
    /// has no material association at all.
    pub fn get(&self, element_id: u32) -> Option<&LayerBuildup> {
        self.element_to_buildup.get(&element_id)
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
fn resolve_layer_set_usage(
    usage: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> LayerBuildup {
    let layer_set_id = match usage.get_ref(0) {
        Some(id) => id,
        None => return LayerBuildup::NotSliceable,
    };
    let axis = match usage.get(1).and_then(|a| a.as_enum()).map(str::to_ascii_uppercase) {
        Some(s) if s == "AXIS1" => LayerAxis::Axis1,
        Some(s) if s == "AXIS2" => LayerAxis::Axis2,
        Some(s) if s == "AXIS3" => LayerAxis::Axis3,
        // Missing or unrecognised → walls default to AXIS2 per spec, but
        // rather than guess, treat as unsliceable.
        _ => return LayerBuildup::NotSliceable,
    };
    let direction_sense = match usage.get(2).and_then(|a| a.as_enum()).map(str::to_ascii_uppercase)
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
        layers.push(LayerInfo { material_id, thickness });
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
