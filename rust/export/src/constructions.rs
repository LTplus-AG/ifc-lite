// SPDX-License-Identifier: MPL-2.0
//! Constructions for the HBJSON exporter — IFC material layer sets → Honeybee opaque
//! constructions (wasm-safe; pure decoding + arithmetic).
//!
//! Layer thicknesses come from `IfcMaterialLayerSet`; thermal properties are defaulted by
//! material-name keyword (IFC rarely carries conductivity/density), so U-values are a sane
//! starting point a user refines in Pollination — not authoritative. One representative
//! build-up per category (wall / slab) is derived and assigned by face type.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{ExtractedProfile, LayerBuildup, MaterialLayerIndex};

use crate::hbjson::{EnergyMaterial, ModelEnergy, OpaqueConstruction};

/// Default (conductivity W/mK, density kg/m³, specific heat J/kgK) by material-name keyword.
fn thermal_props(name: &str) -> (f64, f64, f64) {
    let n = name.to_lowercase();
    if n.contains("insul") || n.contains("mineral") || n.contains("wool") || n.contains("eps") || n.contains("xps") || n.contains("polystyr") {
        (0.035, 30.0, 1200.0)
    } else if n.contains("concrete") {
        (2.3, 2300.0, 900.0)
    } else if n.contains("brick") || n.contains("masonry") || n.contains("block") {
        (0.7, 1900.0, 800.0)
    } else if n.contains("gypsum") || n.contains("plaster") || n.contains("board") || n.contains("drywall") {
        (0.25, 900.0, 1000.0)
    } else if n.contains("timber") || n.contains("wood") || n.contains("plywood") {
        (0.14, 500.0, 1600.0)
    } else if n.contains("steel") || n.contains("metal") || n.contains("alumin") {
        (50.0, 7800.0, 500.0)
    } else if n.contains("glass") {
        (1.0, 2500.0, 840.0)
    } else if n.contains("screed") || n.contains("mortar") || n.contains("render") {
        (0.8, 1800.0, 900.0)
    } else if n.contains("air") {
        (0.18, 1.2, 1000.0)
    } else {
        (1.0, 1000.0, 1000.0)
    }
}

fn sanitize(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
    if out.is_empty() { "Material".to_string() } else { out }
}

/// Map every `IfcMaterial` entity id to its Name (attr 0).
fn material_names(content: &[u8], decoder: &mut EntityDecoder) -> HashMap<u32, String> {
    let mut names = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCMATERIAL" {
            continue;
        }
        if let Ok(e) = decoder.decode_at_with_id(id, start, end) {
            if let Some(name) = e.get(0).and_then(|a| a.as_string()) {
                if !name.is_empty() {
                    names.insert(id, name.to_string());
                }
            }
        }
    }
    names
}

/// Model-level energy library + the construction ids to assign per face type.
pub struct Constructions {
    pub energy: Option<ModelEnergy>,
    pub wall: Option<String>,
    pub floor: Option<String>,
    pub roof: Option<String>,
}

impl Constructions {
    fn none() -> Self {
        Self { energy: None, wall: None, floor: None, roof: None }
    }
}

type Buckets = HashMap<Vec<(u32, i64)>, (usize, Vec<(u32, f64)>)>;

fn build_one(
    bucket: &Buckets,
    con_id: &str,
    names: &HashMap<u32, String>,
    materials: &mut Vec<EnergyMaterial>,
    constructions: &mut Vec<OpaqueConstruction>,
    seen_mat: &mut HashSet<String>,
) -> Option<String> {
    let (_, layers) = bucket.values().max_by_key(|(count, _)| *count)?;
    if layers.is_empty() {
        return None;
    }
    let mut refs = Vec::new();
    for (mid, thickness) in layers {
        let name = names.get(mid).cloned().unwrap_or_else(|| format!("Material{}", mid));
        let ident = format!("{}_{}mm", sanitize(&name), (thickness * 1000.0).round() as i64);
        if seen_mat.insert(ident.clone()) {
            let (k, rho, cp) = thermal_props(&name);
            materials.push(EnergyMaterial::new(ident.clone(), thickness.max(0.001), k, rho, cp));
        }
        refs.push(ident);
    }
    constructions.push(OpaqueConstruction::new(con_id.to_string(), refs));
    Some(con_id.to_string())
}

/// Derive representative wall/slab constructions from the model's material layer sets.
pub fn build_constructions(content: &[u8], profiles: &[ExtractedProfile]) -> Constructions {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let scale = decoder.length_unit_scale();
    let layers = MaterialLayerIndex::from_content(content, &mut decoder);
    if layers.sliceable_count() == 0 {
        return Constructions::none();
    }
    let names = material_names(content, &mut decoder);

    // Vote for the most common build-up per category (signature = material ids + mm thickness).
    let mut wall: Buckets = HashMap::new();
    let mut slab: Buckets = HashMap::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for p in profiles {
        let is_wall = p.ifc_type == "IfcWall" || p.ifc_type == "IfcWallStandardCase";
        let is_slab = p.ifc_type == "IfcSlab" || p.ifc_type == "IfcRoof";
        if (!is_wall && !is_slab) || !seen.insert(p.express_id) {
            continue;
        }
        if let Some(LayerBuildup::Sliceable { layers: ls, .. }) = layers.get(p.express_id) {
            if ls.is_empty() {
                continue;
            }
            let sig: Vec<(u32, i64)> = ls.iter().map(|l| (l.material_id, (l.thickness * scale * 1000.0).round() as i64)).collect();
            let vals: Vec<(u32, f64)> = ls.iter().map(|l| (l.material_id, l.thickness * scale)).collect();
            let bucket = if is_wall { &mut wall } else { &mut slab };
            bucket.entry(sig).or_insert((0, vals)).0 += 1;
        }
    }

    let mut materials = Vec::new();
    let mut constructions = Vec::new();
    let mut seen_mat = HashSet::new();
    let wall_id = build_one(&wall, "ifclite_wall", &names, &mut materials, &mut constructions, &mut seen_mat);
    let slab_id = build_one(&slab, "ifclite_slab", &names, &mut materials, &mut constructions, &mut seen_mat);

    if constructions.is_empty() {
        return Constructions::none();
    }
    Constructions {
        energy: Some(ModelEnergy { ty: "ModelEnergyProperties", materials, constructions }),
        wall: wall_id,
        floor: slab_id.clone(),
        roof: slab_id,
    }
}
