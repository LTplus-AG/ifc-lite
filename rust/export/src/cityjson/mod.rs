// SPDX-License-Identifier: MPL-2.0
//! CityJSON 2.0 export (and CityJSONSeq, its JSON Text Sequence form).
//!
//! One `Building` per `IfcBuilding` (an `IfcBuilding` decomposing another is
//! a `BuildingPart`), with an LoD0 footprint and an LoD1 block derived from
//! its element meshes; `BuildingStorey` per `IfcBuildingStorey`,
//! `BuildingRoom` per `IfcSpace`, and `BuildingConstructiveElement`,
//! `BuildingInstallation` or `BuildingFurniture` per element, the rooms and
//! elements with their IFC body geometry at LoD3. The mapping and the LoD
//! claims are documented in `docs/guide/exporting.md` and on
//! [`geometry`]/[`structure`].
//!
//! Coordinates are map coordinates of an EPSG CRS when the model's
//! `IfcMapConversion` resolves exactly (see [`georef`]), local IFC world
//! metres otherwise, with a warning and no `referenceSystem`. Vertices are
//! integers on a `scale` grid (default 1 mm), deduplicated on that grid.
//!
//! The whole module is compiled only with the `cityjson` feature. The gate is
//! this inner attribute rather than a `cfg` on `mod cityjson;` in `lib.rs`, so
//! tooling that follows plain `mod` declarations (the revert oracle) still
//! reaches the tests below; for the compiler the two are the same.
#![cfg(feature = "cityjson")]

mod attributes;
mod footprint;
mod geometry;
mod georef;
mod structure;
mod vertices;

#[cfg(test)]
#[path = "../cityjson_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "../cityjson_fixture_tests.rs"]
mod fixture_tests;

use std::collections::{HashMap, HashSet};

use ifc_lite_core::IfcType;
use ifc_lite_processing::MeshData;
use serde_json::{json, Map, Value};

use crate::model::{build_export_model_with_options, EntityRow, ModelOptions};
use crate::scene_input::gather;
use geometry::Geometry;
use structure::{Kind, Node};
use vertices::VertexPool;

/// Options for [`try_export_cityjson`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct CityJsonOptions {
    /// `transform.scale`, in output units (metres for a metric CRS or local
    /// output). Default `0.001`: millimetres.
    pub scale: f64,
    /// Write rooms and elements with their LoD3 geometry. When false they
    /// are still written, with attributes but no geometry, and only
    /// buildings carry geometry (LoD0 and LoD1).
    pub element_geometry: bool,
    /// Write a CityJSONSeq (`.city.jsonl`): one `CityJSON` header line, then
    /// one `CityJSONFeature` line per building.
    pub sequence: bool,
}

impl Default for CityJsonOptions {
    fn default() -> Self {
        Self { scale: 0.001, element_geometry: true, sequence: false }
    }
}

/// A finished export.
#[derive(Debug, Clone)]
pub struct CityJsonExport {
    /// The CityJSON document, or the CityJSONSeq lines.
    pub text: String,
    /// `metadata.referenceSystem`, `None` for local coordinates.
    pub reference_system: Option<String>,
    /// Everything the export assumed or could not do, for the user.
    pub warnings: Vec<String>,
    pub buildings: usize,
    pub city_objects: usize,
    pub vertices: usize,
}

/// Why nothing was written. Its own type, like the LandXML terrain refusal:
/// a model with no building is not an export failure but has no CityJSON
/// building model to give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CityJsonRefusal {
    pub reason: String,
}

impl CityJsonRefusal {
    /// Stable machine-readable code, mirrored across the wasm boundary.
    pub const CODE: &'static str = "CITYJSON_REFUSED";
}

impl std::fmt::Display for CityJsonRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", Self::CODE, self.reason)
    }
}

/// Export the model in `content` (raw IFC bytes) as CityJSON 2.0.
pub fn try_export_cityjson(content: &[u8], opts: &CityJsonOptions) -> Result<CityJsonExport, CityJsonRefusal> {
    if !(opts.scale.is_finite() && opts.scale > 0.0 && opts.scale <= 1.0) {
        return Err(CityJsonRefusal { reason: format!("scale {} is not in (0, 1]", opts.scale) });
    }
    let rels = crate::relationships::relationships(content);
    let model = build_export_model_with_options(content, &ModelOptions::default().with_attributes(true).with_inherit_type_properties(true));
    let rows: HashMap<u32, &EntityRow> = model.entities.iter().map(|r| (r.express_id, r)).collect();
    let type_of: HashMap<u32, IfcType> = model.entities.iter().map(|r| (r.express_id, IfcType::from_str(&r.ifc_type))).collect();
    let tree = structure::walk(rels.project, &rels.spatial_children, &type_of);
    let buildings = tree.nodes.iter().filter(|n| n.kind == Kind::Building).count();
    if buildings == 0 {
        return Err(CityJsonRefusal { reason: "the model has no IfcBuilding in its spatial structure; CityJSON export writes buildings".into() });
    }
    let mut warnings = Vec::new();
    if tree.outside_buildings > 0 {
        warnings.push(format!("{} elements outside every IfcBuilding (site elements) are not exported", tree.outside_buildings));
    }
    let frame = georef::resolve(content, &mut warnings);
    let to_out = |p: [f64; 3]| frame.apply(p);

    let scene = gather(content, false, false, None);
    let world = scene.result.frame.world_mapper();
    let mut meshes: HashMap<u32, Vec<&MeshData>> = HashMap::new();
    for m in scene.emittable() {
        meshes.entry(m.express_id).or_default().push(m);
    }

    let ids = object_ids(&tree.nodes, &rows);
    let site_of = site_rows(&rels.spatial_children, &rows, &tree.nodes);
    let mut pool = VertexPool::new(opts.scale);
    let mut objects: Vec<CityObject> = Vec::with_capacity(tree.nodes.len());
    for node in &tree.nodes {
        let mut geoms: Vec<Geometry> = Vec::new();
        let mut measured_height = None;
        if matches!(node.kind, Kind::Building | Kind::BuildingPart) {
            let shaping: Vec<&MeshData> = tree.nodes.iter()
                .filter(|n| n.kind.shapes_building() && n.containers.contains(&node.id))
                .flat_map(|n| meshes.get(&n.id).into_iter().flatten().copied())
                .collect();
            let name = &ids[&node.id];
            match footprint::footprint(&shaping, world, opts.scale / 2.0) {
                Some(fp) => {
                    if fp.approximated > 0 {
                        warnings.push(format!("{name}: {} elements too dense to outline exactly were outlined by their convex hull", fp.approximated));
                    }
                    // On the export grid, so it equals the written block's height.
                    let grid = |z: f64| (to_out([0.0, 0.0, z])[2] / opts.scale).round();
                    measured_height = Some((grid(fp.z_max) - grid(fp.z_min)) * opts.scale);
                    let min_area2 = opts.scale * opts.scale;
                    let mut dropped = 0;
                    geoms.extend(geometry::lod0(&fp, &mut pool, &to_out, min_area2, &mut dropped));
                    // The same polygons again: its count would repeat LoD0's.
                    let mut dropped_lod1 = 0;
                    match geometry::lod1(&fp, &mut pool, &to_out, min_area2, &mut dropped_lod1) {
                        Some(g) => geoms.push(g),
                        None => warnings.push(format!("{name}: the LoD1 block has no height at the export scale and is omitted")),
                    }
                    if dropped > 0 {
                        warnings.push(format!(
                            "{name}: {dropped} footprint rings could not be written as valid polygon rings (an island inside a hole, a hole outside every exterior, or a sliver that is collinear on the export grid) and are missing from LoD0 and LoD1"
                        ));
                    }
                }
                None => warnings.push(format!("{name}: no element geometry to derive a footprint from; written without geometry")),
            }
        } else if opts.element_geometry && node.kind != Kind::Storey {
            if let Some(ms) = meshes.get(&node.id) {
                geoms.extend(geometry::lod3_surfaces(ms, &world, &mut pool, &to_out));
            }
        }
        let row = rows.get(&node.id).copied();
        let ifc_class = type_of.get(&node.id).map(|t| t.name().to_string()).unwrap_or_default();
        let vertical = |m: f64| frame.vertical_length(m);
        let (attrs, conflicts) = attributes::attributes(&attributes::AttributeInput {
            kind: node.kind,
            row,
            ifc_class: &ifc_class,
            storey: node.storey.and_then(|s| ids.get(&s)).map(String::as_str),
            site: node.containers.last().or(Some(&node.id)).and_then(|b| site_of.get(b)).copied(),
            measured_height,
            length_metres: model.units.length_unit_scale,
            vertical: &vertical,
        });
        if !conflicts.is_empty() {
            warnings.push(format!(
                "{}: property sets of the same name were merged and these properties had conflicting values; the first value in model order is kept: {}",
                ids[&node.id],
                conflicts.join(", ")
            ));
        }
        objects.push(CityObject { node: node.clone(), geoms, attrs });
    }

    let mut used = vec![false; pool.len()];
    for g in objects.iter().flat_map(|o| &o.geoms) {
        for &i in &g.used {
            used[i as usize] = true;
        }
    }
    let remap = pool.compact(&used);
    for g in objects.iter_mut().flat_map(|o| &mut o.geoms) {
        g.used.iter_mut().for_each(|i| *i = remap[*i as usize]);
        if let Some(b) = g.value.get_mut("boundaries") {
            remap_indices(b, &|i| u64::from(remap[i as usize]));
        }
    }

    let mut doc = Document { ids: &ids, objects, pool, frame: &frame, opts };
    let title = rels.project.and_then(|p| crate::ifc5::decode_one(content, p))
        .and_then(|e| e.string_at(ifc_lite_core::slot::IfcProject::NAME).map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    let text = if opts.sequence { doc.sequence(title.as_deref()) } else { doc.document(title.as_deref()) }
        .map_err(|e| CityJsonRefusal { reason: format!("serialization failed: {e}") })?;
    Ok(CityJsonExport {
        text,
        reference_system: frame.reference_system(),
        warnings,
        buildings,
        city_objects: doc.objects.len(),
        vertices: doc.pool.len(),
    })
}

struct CityObject {
    node: Node,
    geoms: Vec<Geometry>,
    attrs: Map<String, Value>,
}

/// City Object ids: the IFC `GlobalId` when it is present and unique, else
/// `ifc-<express id>`.
fn object_ids(nodes: &[Node], rows: &HashMap<u32, &EntityRow>) -> HashMap<u32, String> {
    let gid = |id: u32| rows.get(&id).and_then(|r| r.global_id.as_deref()).filter(|g| !g.is_empty());
    let mut count: HashMap<&str, usize> = HashMap::new();
    for n in nodes {
        if let Some(g) = gid(n.id) {
            *count.entry(g).or_default() += 1;
        }
    }
    nodes.iter().map(|n| {
        let id = match gid(n.id) {
            Some(g) if count[g] == 1 && !g.starts_with("ifc-") => g.to_string(),
            _ => format!("ifc-{}", n.id),
        };
        (n.id, id)
    }).collect()
}

/// Each top-level building's `IfcSite` row (its spatial parent), for `EGRID`.
fn site_rows<'a>(children: &HashMap<u32, Vec<u32>>, rows: &HashMap<u32, &'a EntityRow>, nodes: &[Node]) -> HashMap<u32, &'a EntityRow> {
    let buildings: HashSet<u32> = nodes.iter().filter(|n| n.kind == Kind::Building).map(|n| n.id).collect();
    let mut out = HashMap::new();
    for (parent, kids) in children {
        let Some(row) = rows.get(parent).filter(|r| IfcType::from_str(&r.ifc_type).is_subtype_of(IfcType::IfcSite)) else { continue };
        for kid in kids.iter().filter(|k| buildings.contains(k)) {
            out.insert(*kid, *row);
        }
    }
    out
}

struct Document<'a> {
    ids: &'a HashMap<u32, String>,
    objects: Vec<CityObject>,
    pool: VertexPool,
    frame: &'a georef::OutputFrame,
    opts: &'a CityJsonOptions,
}

impl Document<'_> {
    fn transform(&self) -> Value {
        let s = self.opts.scale;
        json!({ "scale": [s, s, s], "translate": self.pool.translate() })
    }

    fn metadata(&self, title: Option<&str>) -> Value {
        let mut m = Map::new();
        if let Some(e) = self.pool.extent(0..self.pool.len() as u32) {
            m.insert("geographicalExtent".into(), json!(e));
        }
        if let Some(crs) = self.frame.reference_system() {
            m.insert("referenceSystem".into(), json!(crs));
        }
        if let Some(t) = title {
            m.insert("title".into(), json!(t));
        }
        Value::Object(m)
    }

    /// The City Objects `members` (indices into `objects`), with `boundaries`
    /// remapped through `remap` (global pool index → written index).
    fn city_objects(&self, members: &[usize], remap: &impl Fn(u32) -> u64) -> Map<String, Value> {
        let index: HashSet<u32> = members.iter().map(|&i| self.objects[i].node.id).collect();
        let mut children: HashMap<u32, Vec<&str>> = HashMap::new();
        for &i in members {
            let n = &self.objects[i].node;
            if let Some(p) = n.parent.filter(|p| index.contains(p)) {
                children.entry(p).or_default().push(&self.ids[&n.id]);
            }
        }
        let mut out = Map::new();
        for &i in members {
            let o = &self.objects[i];
            let mut co = Map::new();
            co.insert("type".into(), json!(o.node.kind.city_type()));
            co.insert("attributes".into(), Value::Object(o.attrs.clone()));
            if let Some(p) = o.node.parent {
                co.insert("parents".into(), json!([self.ids[&p]]));
            }
            if let Some(kids) = children.get(&o.node.id) {
                co.insert("children".into(), json!(kids));
            }
            if !o.geoms.is_empty() {
                if let Some(e) = self.pool.extent(o.geoms.iter().flat_map(|g| g.used.iter().copied())) {
                    co.insert("geographicalExtent".into(), json!(e));
                }
                let geoms: Vec<Value> = o.geoms.iter().map(|g| {
                    let mut v = g.value.clone();
                    if let Some(b) = v.get_mut("boundaries") {
                        remap_indices(b, remap);
                    }
                    v
                }).collect();
                co.insert("geometry".into(), Value::Array(geoms));
            }
            out.insert(self.ids[&o.node.id].clone(), Value::Object(co));
        }
        out
    }

    fn document(&mut self, title: Option<&str>) -> serde_json::Result<String> {
        let all: Vec<usize> = (0..self.objects.len()).collect();
        let doc = json!({
            "type": "CityJSON",
            "version": "2.0",
            "transform": self.transform(),
            "metadata": self.metadata(title),
            "CityObjects": self.city_objects(&all, &|i| u64::from(i)),
            "vertices": self.pool.integers(),
        });
        serde_json::to_string(&doc)
    }

    /// CityJSONSeq (spec §7.2): a header `CityJSON` object with the transform
    /// and metadata and no objects, then one `CityJSONFeature` per building
    /// holding the building and all its descendants with local vertices.
    fn sequence(&mut self, title: Option<&str>) -> serde_json::Result<String> {
        let header = json!({
            "type": "CityJSON",
            "version": "2.0",
            "transform": self.transform(),
            "metadata": self.metadata(title),
            "CityObjects": {},
            "vertices": [],
        });
        let mut out = serde_json::to_string(&header)?;
        out.push('\n');
        let integers = self.pool.integers();
        for (bi, b) in self.objects.iter().enumerate().filter(|(_, o)| o.node.kind == Kind::Building) {
            let members: Vec<usize> = std::iter::once(bi)
                .chain(self.objects.iter().enumerate().filter(|(_, o)| o.node.containers.last() == Some(&b.node.id)).map(|(i, _)| i))
                .collect();
            let mut used: Vec<u32> = members.iter().flat_map(|&i| self.objects[i].geoms.iter().flat_map(|g| g.used.iter().copied())).collect();
            used.sort_unstable();
            used.dedup();
            let local: HashMap<u32, u64> = used.iter().enumerate().map(|(k, &g)| (g, k as u64)).collect();
            let feature = json!({
                "type": "CityJSONFeature",
                "id": self.ids[&b.node.id],
                "CityObjects": self.city_objects(&members, &|g| local[&g]),
                "vertices": used.iter().map(|&g| integers[g as usize]).collect::<Vec<_>>(),
            });
            out.push_str(&serde_json::to_string(&feature)?);
            out.push('\n');
        }
        Ok(out)
    }
}

/// Rewrite every integer in a `boundaries` array through `remap`.
fn remap_indices(v: &mut Value, remap: &impl Fn(u32) -> u64) {
    match v {
        Value::Array(items) => items.iter_mut().for_each(|i| remap_indices(i, remap)),
        Value::Number(n) => {
            if let Some(i) = n.as_u64().and_then(|i| u32::try_from(i).ok()) {
                *v = json!(remap(i));
            }
        }
        _ => {}
    }
}
