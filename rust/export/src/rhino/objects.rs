// SPDX-License-Identifier: MPL-2.0
//! Materials, meshes, blocks, groups and objects from the selected elements.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use ifc_lite_processing::{MeshData, Rgba};

use super::elements::{Geometry, Occurrence, Selection};
use super::identity::ObjectIds;
use super::layers::{LayerRequest, Layers};
use super::names::{bracket_safe, clean_name, NameSet};
use super::options::RhinoProperties;
use super::source::ModelInfo;
use super::space::OutputSpace;
use super::user_text::{element_text, TextCache};
use super::wire::{RhinoBlock, RhinoGeometry, RhinoGroup, RhinoMaterial, RhinoMesh, RhinoObject};
use crate::color_space::material_key;

/// Material identity: rounded RGBA key, then the IFC style name.
type MaterialKey<'a> = ((i32, i32, i32, i32), Option<&'a str>);

fn mesh_material(m: &MeshData) -> MaterialKey<'_> {
    (material_key(m.color), m.material_name.as_deref())
}

/// An occurrence keeps its template's style name only while it keeps the
/// template's colour; an occurrence restyled to another colour is unnamed.
fn occurrence_material<'a>(o: &Occurrence<'a>) -> MaterialKey<'a> {
    let key = material_key(o.color);
    (key, o.template.material_name.as_deref().filter(|_| key == material_key(o.template.color)))
}

/// An IFC colour as the scene's sRGB bytes.
fn rgba8(c: [f32; 4]) -> [u8; 4] {
    Rgba(c).to_rgba8()
}

/// The material table, ordered by colour key then name. Names are the IFC
/// style name or `IFC #RRGGBB`; a name taken ignoring case (as openNURBS
/// compares) gets the first free ` (2)`, ` (3)`.
pub(super) struct Materials<'a> {
    pub(super) table: Vec<RhinoMaterial>,
    index: HashMap<MaterialKey<'a>, usize>,
}

impl<'a> Materials<'a> {
    pub(super) fn build(sel: &Selection<'a>) -> Self {
        let mut colors: BTreeMap<MaterialKey<'a>, [f32; 4]> = BTreeMap::new();
        for element in sel.elements.values() {
            match &element.geometry {
                Geometry::Meshes(parts) => {
                    for m in parts {
                        colors.entry(mesh_material(m)).or_insert(m.color);
                    }
                }
                Geometry::Instance(o) => {
                    colors.entry(occurrence_material(o)).or_insert(o.color);
                }
            }
        }
        let mut names = NameSet::default();
        let mut table = Vec::with_capacity(colors.len());
        let mut index = HashMap::with_capacity(colors.len());
        for (key, color) in colors {
            let rgba = rgba8(color);
            index.insert(key, table.len());
            table.push(RhinoMaterial {
                name: material_name(&mut names, key.1, rgba),
                diffuse: [rgba[0], rgba[1], rgba[2]],
                transparency: f64::from(1.0 - color[3].clamp(0.0, 1.0)),
            });
        }
        Self { table, index }
    }
}

/// A material's name, unique in `names`: the IFC style name, else
/// `IFC #RRGGBB` of `rgba`, then the first free ` (2)`, ` (3)`.
fn material_name(names: &mut NameSet, style: Option<&str>, rgba: [u8; 4]) -> String {
    // Same cleaning as layer and group names: openNURBS trims before it compares names.
    let base = style
        .and_then(clean_name)
        .map_or_else(|| format!("IFC #{:02X}{:02X}{:02X}", rgba[0], rgba[1], rgba[2]), |n| bracket_safe(&n));
    let numbered = (2..).map(|n| format!("{base} ({n})"));
    names.claim(std::iter::once(base.clone()).chain(numbered))
}

/// Append `m`'s triangles to `out`, mapping vertices into the file. `baked`
/// meshes are placed (`origin + position`, frame); block geometry stays in
/// the template's local frame, only scaled. The `world` branch is taken once
/// per mesh, not per vertex.
fn append_mesh(out: &mut RhinoMesh, m: &MeshData, space: &OutputSpace, normals: bool, baked: bool) {
    let [ox, oy, oz] = m.origin;
    if !baked {
        append_mapped(out, m, normals, |p| space.to_units(p), KEEP_NORMALS);
    } else if let Some(frame) = space.world_frame() {
        let to_world = frame.world_mapper();
        append_mapped(out, m, normals, |[x, y, z]| space.to_units(to_world([ox + x, oy + y, oz + z])), Some(frame.direction_mapper()));
    } else {
        append_mapped(out, m, normals, |[x, y, z]| space.to_units([ox + x, oy + y, oz + z]), KEEP_NORMALS);
    }
}

/// Normals copied as they are: the frame does not turn them.
const KEEP_NORMALS: Option<fn([f64; 3]) -> [f64; 3]> = None;

/// [`append_mesh`] with `place` mapping a mesh position into the file and
/// `turn` a normal (`None` copies normals unchanged).
fn append_mapped<P, D>(out: &mut RhinoMesh, m: &MeshData, normals: bool, place: P, turn: Option<D>)
where
    P: Fn([f64; 3]) -> [f64; 3],
    D: Fn([f64; 3]) -> [f64; 3],
{
    let base = (out.positions.len() / 3) as u32;
    out.positions.reserve(m.positions.len());
    for p in m.positions.chunks_exact(3) {
        out.positions.extend_from_slice(&place([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])]));
    }
    if normals {
        let dst = out.normals.get_or_insert_with(Vec::new);
        match turn {
            Some(turn) => {
                dst.reserve(m.normals.len());
                for n in m.normals.chunks_exact(3) {
                    dst.extend(turn([f64::from(n[0]), f64::from(n[1]), f64::from(n[2])]).map(|c| c as f32));
                }
            }
            None => dst.extend_from_slice(&m.normals),
        }
    }
    out.indices.extend(m.indices.iter().map(|&i| i + base));
}

/// Everything the objects pass writes.
#[derive(Default)]
pub(super) struct Built {
    pub(super) meshes: Vec<RhinoMesh>,
    pub(super) blocks: Vec<RhinoBlock>,
    pub(super) groups: Vec<RhinoGroup>,
    pub(super) objects: Vec<RhinoObject>,
    /// `(key, express id)` of the first user-text key collision.
    pub(super) collision: Option<(String, u32)>,
    /// Express id of the first element whose group name or an `objectId` was
    /// taken (elements sharing a GlobalId) and fell back to its express id.
    pub(super) repeated_identity: Option<u32>,
}

pub(super) struct ObjectContext<'a> {
    pub(super) info: &'a ModelInfo,
    pub(super) space: &'a OutputSpace,
    pub(super) materials: &'a Materials<'a>,
    pub(super) layers: &'a Layers<'a>,
    pub(super) layer_of: &'a HashMap<u32, LayerRequest<'a>>,
    pub(super) properties: RhinoProperties,
    pub(super) normals: bool,
}

/// One object of an element: what it draws, its material index, colour and
/// the material name its `IFC::Material` shows.
struct Part<'m> {
    geometry: RhinoGeometry,
    material: usize,
    color: [f32; 4],
    material_name: Option<&'m str>,
}

/// Blocks (one per template some written element instantiates, by template
/// id), then objects by express id.
pub(super) fn build_objects(sel: &Selection<'_>, cx: &ObjectContext<'_>) -> Built {
    let mut b = Built::default();
    let block_of = build_blocks(&mut b, sel, cx);
    let mut cache = TextCache::default();
    let mut group_names = NameSet::default();
    let mut object_ids = ObjectIds::default();
    for (&id, element) in &sel.elements {
        let layer = cx.layers.index[&cx.layer_of[&id]];
        let mut parts: Vec<Part<'_>> = match &element.geometry {
            Geometry::Meshes(meshes) => merge_parts(&mut b, meshes, cx),
            Geometry::Instance(o) => {
                let key = occurrence_material(o);
                let xform = cx.space.instance_xform(&o.transform, o.template.origin);
                vec![Part {
                    geometry: RhinoGeometry::Instance { block: block_of[&o.template.express_id], xform },
                    material: cx.materials.index[&key],
                    color: o.color,
                    material_name: key.1,
                }]
            }
        };
        let facts = element.facts.with_row(cx.info.rows.get(&id));
        let text = element_text(cx.info, &mut cache, id, &facts, cx.properties);
        if let (None, Some(key)) = (&b.collision, &text.first_collision) {
            b.collision = Some((key.clone(), id));
        }
        let global_id = facts.global_id.filter(|g| !g.is_empty());
        let mut repeated = false;
        let group = (parts.len() > 1).then(|| {
            let (name, renamed) = group_name(&mut group_names, global_id, id);
            repeated |= renamed;
            b.groups.push(RhinoGroup { name });
            b.groups.len() - 1
        });
        let name = facts.name.filter(|n| !n.trim().is_empty()).unwrap_or(facts.ifc_type);
        let mut object = |index: usize, part: Part<'_>, user_strings| {
            let (object_id, fell_back) = object_ids.claim(global_id, id, index);
            repeated |= fell_back;
            RhinoObject {
                geometry: part.geometry,
                layer,
                name: name.to_string(),
                object_id,
                color: rgba8(part.color),
                material: part.material,
                groups: group.into_iter().collect(),
                user_strings,
            }
        };
        // Every part but the last copies the text; the last takes it.
        let last = parts.pop();
        let count = parts.len();
        for (index, part) in parts.into_iter().enumerate() {
            let strings = text.for_part(part.material_name);
            b.objects.push(object(index, part, strings));
        }
        if let Some(part) = last {
            let strings = text.into_part(part.material_name);
            b.objects.push(object(count, part, strings));
        }
        if repeated && b.repeated_identity.is_none() {
            b.repeated_identity = Some(id);
        }
    }
    b
}

/// A grouped element's group name, unique in `names` (openNURBS refuses a
/// repeated group name and trims whitespace): its GlobalId (`#<express id>`
/// when it has none), then ` #<express id>`, then ` (2)`, ` (3)` after that;
/// true when the first was taken.
fn group_name(names: &mut NameSet, global_id: Option<&str>, id: u32) -> (String, bool) {
    let base = global_id.and_then(clean_name).unwrap_or_else(|| format!("#{id}"));
    let with_id = format!("{base} #{id}");
    let numbered = (2..).map(|n| format!("{with_id} ({n})"));
    let name = names.claim([base.clone(), with_id.clone()].into_iter().chain(numbered));
    let renamed = name != base;
    (name, renamed)
}

/// One block per template some written element instantiates, in template
/// id order; returns the block index of each template id.
fn build_blocks(b: &mut Built, sel: &Selection<'_>, cx: &ObjectContext<'_>) -> HashMap<u32, usize> {
    let used: BTreeSet<u32> = sel
        .elements
        .values()
        .filter_map(|e| match &e.geometry {
            Geometry::Instance(o) => Some(o.template.express_id),
            Geometry::Meshes(_) => None,
        })
        .collect();
    let mut block_of = HashMap::with_capacity(used.len());
    for tid in used {
        let template = sel.templates[&tid];
        let mut mesh = RhinoMesh::default();
        append_mesh(&mut mesh, template, cx.space, cx.normals, false);
        b.meshes.push(mesh);
        block_of.insert(tid, b.blocks.len());
        b.blocks.push(RhinoBlock {
            name: format!("{} {tid}", template.ifc_type),
            description: format!("Mapped geometry of {} #{tid}", template.ifc_type),
            meshes: vec![b.meshes.len() - 1],
            layer: cx.layers.block_layer.expect("a block implies the block layer"),
        });
    }
    block_of
}

/// One merged mesh per material of the element's submeshes, in material order.
fn merge_parts<'m>(b: &mut Built, meshes: &[&'m MeshData], cx: &ObjectContext<'_>) -> Vec<Part<'m>> {
    let mut by_material: BTreeMap<usize, Vec<&'m MeshData>> = BTreeMap::new();
    for m in meshes {
        by_material.entry(cx.materials.index[&mesh_material(m)]).or_default().push(m);
    }
    by_material
        .into_iter()
        .map(|(material, group)| {
            let mut mesh = RhinoMesh::default();
            for m in &group {
                append_mesh(&mut mesh, m, cx.space, cx.normals, true);
            }
            b.meshes.push(mesh);
            let first = group[0];
            Part {
                geometry: RhinoGeometry::Mesh { mesh: b.meshes.len() - 1 },
                material,
                color: first.color,
                material_name: first.material_name.as_deref(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(styles: &[Option<&str>]) -> Vec<String> {
        let mut set = NameSet::default();
        styles.iter().map(|&style| material_name(&mut set, style, [255, 0, 0, 255])).collect()
    }

    /// openNURBS compares material names ignoring case, so case variants of
    /// one style name are numbered like exact repeats.
    #[test]
    fn material_names_are_unique_ignoring_case() {
        assert_eq!(names(&[Some("Steel"), Some("STEEL"), Some("steel")]), ["Steel", "STEEL (2)", "steel (3)"]);
        assert_eq!(names(&[None, None, Some("ifc #ff0000")]), ["IFC #FF0000", "IFC #FF0000 (2)", "ifc #ff0000 (3)"]);
        // Trimmed before comparison, as openNURBS does (review on #9415).
        assert_eq!(names(&[Some("Concrete"), Some("Concrete "), Some("\u{200B}Concrete")]), ["Concrete", "Concrete (2)", "Concrete (3)"]);
    }

    /// openNURBS refuses a repeated group name and trims whitespace: a
    /// repeated GlobalId takes ` #<express id>`, then ` (n)`.
    #[test]
    fn group_names_are_unique() {
        let mut set = NameSet::default();
        let gid = Some("2O2Fr$t4X7Zf8NOew3FLOH");
        assert_eq!(group_name(&mut set, gid, 5), ("2O2Fr$t4X7Zf8NOew3FLOH".to_string(), false));
        assert_eq!(group_name(&mut set, Some(" 2O2Fr$t4X7Zf8NOew3FLOH "), 6), ("2O2Fr$t4X7Zf8NOew3FLOH #6".to_string(), true));
        assert_eq!(group_name(&mut set, Some("x #7"), 9), ("x #7".to_string(), false));
        assert_eq!(group_name(&mut set, Some("x"), 7), ("x".to_string(), false));
        assert_eq!(group_name(&mut set, Some("X"), 7), ("X #7 (2)".to_string(), true));
        assert_eq!(group_name(&mut set, None, 8), ("#8".to_string(), false));
    }

    /// A style literally named `X (2)` is not handed to a later repeat of `X`.
    #[test]
    fn a_literal_numbered_style_name_is_not_reused() {
        assert_eq!(names(&[Some("X (2)"), Some("X"), Some("X")]), ["X (2)", "X", "X (3)"]);
        assert_eq!(names(&[Some("X"), Some("X"), Some("X (2)")]), ["X", "X (2)", "X (2) (2)"]);
    }
}
