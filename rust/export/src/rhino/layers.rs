// SPDX-License-Identifier: MPL-2.0
//! The layer table: spatial tree, class or presentation layers, `Unassigned`
//! and the block-geometry layer, in deterministic tree order.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use ifc_lite_core::IfcType;
use ifc_lite_geometry::cmp_f64_nan_last;
use ifc_lite_processing::default_color_for_type;

use super::names::{bracket_safe, clean_name, NameSet};
use super::source::ModelInfo;
use super::wire::RhinoLayer;
use crate::scene_input::is_space;

/// Neutral grey for every layer that is not an IFC class.
const GREY: [u8; 4] = [128, 128, 128, 255];
pub(super) const UNASSIGNED: &str = "Unassigned";
pub(super) const NO_PRESENTATION_LAYER: &str = "No presentation layer";
pub(super) const BLOCK_LAYER: &str = "IFC block geometry";

/// Where an object's layer hangs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) enum Anchor<'a> {
    /// A spatial node: the project or a layer-class node.
    Spatial(u32),
    /// The project root of the `class` and `presentation` schemes.
    Root,
    /// A presentation layer under the root: `Some(name)`, or `None` for elements with no
    /// assignment, which stays distinct from a real layer named like the fallback.
    Presentation(Option<&'a str>),
    /// Top-level layer for elements no spatial container reaches.
    Unassigned,
}

/// An object's layer: its anchor, then a class sublayer when `class` is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) struct LayerRequest<'a> {
    pub(super) anchor: Anchor<'a>,
    pub(super) class: Option<&'a str>,
}

/// A layer name as Rhino can hold it: [`clean_name`], then [`bracket_safe`].
fn sanitize_layer_name(raw: &str) -> Option<String> {
    clean_name(raw).map(|s| bracket_safe(&s))
}

#[derive(Default)]
struct Table {
    layers: Vec<RhinoLayer>,
    /// Each parent's children's names.
    names: HashMap<Option<usize>, NameSet>,
}

impl Table {
    /// Add a layer, making its name unique among its siblings, ignoring case
    /// as openNURBS does: ` #<id>` for a node with an express id, then ` (2)`,
    /// ` (3)`. The first spelling is kept as written.
    fn add(&mut self, parent: Option<usize>, name: &str, id: Option<u32>, color: [u8; 4], visible: bool, locked: bool) -> usize {
        let with_id = id.map(|id| format!("{name} #{id}"));
        let base = with_id.clone().unwrap_or_else(|| name.to_string());
        let candidates = std::iter::once(name.to_string()).chain(with_id).chain((2..).map(|n| format!("{base} ({n})")));
        let unique = self.names.entry(parent).or_default().claim(candidates);
        self.layers.push(RhinoLayer { name: unique, parent, color, visible, locked });
        self.layers.len() - 1
    }
}

fn class_color(class: &str) -> [u8; 4] {
    default_color_for_type(IfcType::from_str(class)).to_rgba8()
}

/// The built table and where each request landed.
pub(super) struct Layers<'a> {
    pub(super) layers: Vec<RhinoLayer>,
    pub(super) index: HashMap<LayerRequest<'a>, usize>,
    pub(super) block_layer: Option<usize>,
}

/// Build every layer the requests need, plus the whole spatial tree in the
/// `spatial-class` scheme (`spatial` true).
pub(super) fn build_layers<'a>(
    info: &ModelInfo,
    spatial: bool,
    requests: &BTreeSet<LayerRequest<'a>>,
    with_blocks: bool,
) -> Layers<'a> {
    let mut by_anchor: BTreeMap<Anchor<'a>, Vec<&'a str>> = BTreeMap::new();
    for r in requests {
        let classes = by_anchor.entry(r.anchor).or_default();
        classes.extend(r.class);
    }
    let mut b = Builder { table: Table::default(), index: HashMap::new(), by_anchor };

    if spatial {
        if let Some(pid) = info.project {
            let tree = spatial_layer_tree(info);
            b.spatial_tree(info, &tree, pid);
        }
    } else if b.by_anchor.keys().any(|a| matches!(a, Anchor::Root | Anchor::Presentation(_))) {
        let name = info.project.map(|p| info.node_name(p)).unwrap_or_else(|| "Project".to_string());
        let root = b.anchor_layer(None, Anchor::Root, &name, info.project);
        let presentations: Vec<Option<&str>> =
            b.by_anchor.keys().filter_map(|a| if let Anchor::Presentation(name) = a { Some(*name) } else { None }).collect();
        for name in presentations {
            let anchor = Anchor::Presentation(name);
            let layer = b.anchor_layer(Some(root), anchor, name.unwrap_or(NO_PRESENTATION_LAYER), None);
            b.class_layers(anchor, layer);
        }
        b.class_layers(Anchor::Root, root);
    }
    if b.by_anchor.contains_key(&Anchor::Unassigned) {
        let layer = b.anchor_layer(None, Anchor::Unassigned, UNASSIGNED, None);
        b.class_layers(Anchor::Unassigned, layer);
    }
    let block_layer = with_blocks.then(|| b.table.add(None, BLOCK_LAYER, None, GREY, true, true));
    Layers { layers: b.table.layers, index: b.index, block_layer }
}

struct Builder<'a> {
    table: Table,
    index: HashMap<LayerRequest<'a>, usize>,
    /// Each anchor's class sublayers, alphabetical (the request set's order).
    by_anchor: BTreeMap<Anchor<'a>, Vec<&'a str>>,
}

impl<'a> Builder<'a> {
    /// Add a grey anchor layer; returns it.
    fn anchor_layer(&mut self, parent: Option<usize>, anchor: Anchor<'a>, name: &str, id: Option<u32>) -> usize {
        let name = sanitize_layer_name(name).unwrap_or_else(|| id.map_or("Layer".to_string(), |i| format!("#{i}")));
        let layer = self.table.add(parent, &name, id, GREY, true, false);
        self.index.insert(LayerRequest { anchor, class: None }, layer);
        layer
    }

    /// The anchor's class sublayers, under `parent`.
    fn class_layers(&mut self, anchor: Anchor<'a>, parent: usize) {
        let classes = self.by_anchor.get(&anchor).cloned().unwrap_or_default();
        for class in classes {
            let name = sanitize_layer_name(class).unwrap_or_else(|| "IfcProduct".to_string());
            let layer = self.table.add(Some(parent), &name, None, class_color(class), !is_space(class), false);
            self.index.insert(LayerRequest { anchor, class: Some(class) }, layer);
        }
    }

    /// The spatial subtree at `root`: each node, its spatial children, then
    /// its class sublayers, in pre-order. Iterative with a visited set, so a
    /// file's nesting depth cannot overflow the stack and no depth cap
    /// rejects a valid tree.
    fn spatial_tree(&mut self, info: &ModelInfo, tree: &HashMap<u32, Vec<u32>>, root: u32) {
        enum Step {
            Node(u32, Option<usize>),
            Classes(u32, usize),
        }
        let mut seen = HashSet::new();
        let mut stack = vec![Step::Node(root, None)];
        while let Some(step) = stack.pop() {
            match step {
                Step::Node(id, parent) => {
                    if !seen.insert(id) {
                        continue;
                    }
                    let layer = self.anchor_layer(parent, Anchor::Spatial(id), &info.node_name(id), Some(id));
                    // Popped after every child's subtree, which are pushed reversed so they pop in order.
                    stack.push(Step::Classes(id, layer));
                    let kids = tree.get(&id).map(Vec::as_slice).unwrap_or(&[]);
                    stack.extend(kids.iter().rev().map(|&child| Step::Node(child, Some(layer))));
                }
                Step::Classes(id, layer) => self.class_layers(Anchor::Spatial(id), layer),
            }
        }
    }
}

/// Layer-class children of each spatial layer node, sorted by elevation
/// (storeys) then express id. A layer-class node's tree parent is the
/// nearest layer node above it, so a storey inside a space-less building
/// part still hangs under its building.
fn spatial_layer_tree(info: &ModelInfo) -> HashMap<u32, Vec<u32>> {
    let mut tree: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&id, &parent) in &info.parent {
        if let (true, Some(up)) = (info.is_layer_node(id), info.layer_node(parent)) {
            tree.entry(up).or_default().push(id);
        }
    }
    for kids in tree.values_mut() {
        kids.sort_by(|a, b| {
            let ea = info.elevation(*a).unwrap_or(f64::NAN);
            let eb = info.elevation(*b).unwrap_or(f64::NAN);
            cmp_f64_nan_last(ea, eb).then(a.cmp(b))
        });
    }
    tree
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_names_drop_separators_and_control_characters() {
        assert_eq!(sanitize_layer_name("  A::B  ").as_deref(), Some("A:B"));
        assert_eq!(sanitize_layer_name("A:::B").as_deref(), Some("A:B"));
        assert_eq!(sanitize_layer_name("Le\tvel\u{1}").as_deref(), Some("Level"));
        assert_eq!(sanitize_layer_name(" \n "), None);
        assert_eq!(sanitize_layer_name("\u{200B}Level\u{A0}").as_deref(), Some("Level"));
    }

    /// openNURBS 8.35 (rhino3dm.js) stores a layer whose name starts with one
    /// of `()[]{}` as `Layer <n>`; every other printable ASCII first character
    /// was kept [ran].
    #[test]
    fn layer_names_never_start_with_a_bracket() {
        for (raw, want) in [("(A) Level", "_(A) Level"), ("[x", "_[x"), ("{x", "_{x"), (" )x", "_)x"), ("]", "_]"), ("}x", "_}x")] {
            assert_eq!(sanitize_layer_name(raw).as_deref(), Some(want), "{raw:?}");
        }
        assert_eq!(sanitize_layer_name("A (1)").as_deref(), Some("A (1)"));
        assert_eq!(sanitize_layer_name("_(A)").as_deref(), Some("_(A)"));
        assert_eq!(bracket_safe(" [Steel]"), "_[Steel]");
        assert_eq!(bracket_safe(" Steel "), " Steel ");
    }

    /// openNURBS renamed a sibling `LEVEL 1` of `Level 1` to `LEVEL 1 03` and
    /// refused (`ON_UNSET_INT_INDEX`) a sibling `ü` of `Ü` [ran].
    #[test]
    fn sibling_names_are_unique_ignoring_case() {
        let mut t = Table::default();
        let root = t.add(None, "P", None, GREY, true, false);
        t.add(Some(root), "Level 1", Some(7), GREY, true, false);
        t.add(Some(root), "LEVEL 1", Some(9), GREY, true, false);
        t.add(Some(root), "level 1 #9", None, GREY, true, false);
        t.add(Some(root), "Ü", None, GREY, true, false);
        t.add(Some(root), "ü", None, GREY, true, false);
        t.add(None, "p", None, GREY, true, false);
        let names: Vec<&str> = t.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["P", "Level 1", "LEVEL 1 #9", "level 1 #9 (2)", "Ü", "ü (2)", "p (2)"]);
    }

    #[test]
    fn duplicate_siblings_get_their_express_id() {
        let mut t = Table::default();
        let root = t.add(None, "P", None, GREY, true, false);
        t.add(Some(root), "Walls", Some(7), GREY, true, false);
        t.add(Some(root), "Walls", Some(9), GREY, true, false);
        t.add(Some(root), "Walls", None, GREY, true, false);
        t.add(None, "Walls", Some(3), GREY, true, false);
        let names: Vec<&str> = t.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["P", "Walls", "Walls #9", "Walls (2)", "Walls"]);
    }
}
