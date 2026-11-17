// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The scene's top-level nodes, shared by every glTF assembler.
//!
//! Each assembler emits one node per mesh part and records it here. `finish`
//! then builds what the scene lists:
//!
//! * by default, ONE unnamed root that parents every part node and carries the
//!   model translation and site rotation (the historical layout, byte for byte);
//! * with [`GltfOptions::name_by_global_id`](super::GltfOptions::name_by_global_id)
//!   (#9011), one node per IFC element, named by its `GlobalId`, that parents
//!   that element's parts. Each element node carries its own copy of the root's
//!   translation and rotation, so every part ends up at the same world pose as
//!   under the shared root: the same transform chain, one level shorter. Nothing
//!   is re-baked, and geometry, accessors and materials are untouched.
//!
//! Parts are grouped by express id and `GlobalId` together. The express id
//! alone is unique per element in a well-formed file, but a malformed one can
//! reuse a STEP id for two elements, and keying on it alone would then hang
//! one element's parts under the other's name. Element nodes keep the order
//! in which each element's first part was emitted, which is deterministic for
//! every assembler.

use rustc_hash::FxHashMap;

use super::Node;

/// Part nodes in emission order, and the element each one belongs to.
pub(super) enum SceneNodes {
    /// The default: every part under one root.
    Root(Vec<u32>),
    /// One node per element (#9011).
    Elements {
        /// (usable `GlobalId`, part nodes) per element, in first-emitted order.
        elements: Vec<(Option<String>, Vec<u32>)>,
        /// Express id to its elements' indices in `elements`: one, unless the
        /// file reused the id.
        by_id: FxHashMap<u32, Vec<usize>>,
    },
}

impl SceneNodes {
    pub(super) fn new(name_by_global_id: bool) -> Self {
        match name_by_global_id {
            true => SceneNodes::Elements { elements: Vec::new(), by_id: FxHashMap::default() },
            false => SceneNodes::Root(Vec::new()),
        }
    }

    /// Record part node `node`, emitted for element `express_id`.
    pub(super) fn push(&mut self, node: u32, express_id: u32, global_id: Option<&str>) {
        match self {
            SceneNodes::Root(parts) => parts.push(node),
            SceneNodes::Elements { elements, by_id } => {
                let global_id = usable_global_id(global_id);
                let slots = by_id.entry(express_id).or_default();
                let at = match slots.iter().copied().find(|&e| elements[e].0.as_deref() == global_id) {
                    Some(at) => at,
                    None => {
                        elements.push((global_id.map(str::to_owned), Vec::new()));
                        slots.push(elements.len() - 1);
                        elements.len() - 1
                    }
                };
                elements[at].1.push(node);
            }
        }
    }

    /// Append the top-level node(s) to `nodes` and return the scene's node list.
    /// `translation` / `rotation` are the scene root's transform
    /// ([`scene_root`](super::scene_root)). No parts means an empty scene.
    pub(super) fn finish(
        self,
        nodes: &mut Vec<Node>,
        translation: Option<[f64; 3]>,
        rotation: Option<[f32; 4]>,
    ) -> Vec<u32> {
        let top = |name: Option<String>, children: Vec<u32>| Node {
            name,
            rotation,
            mesh: None,
            children: Some(children),
            translation,
            scale: None,
            matrix: None,
            extras: None,
        };
        match self {
            SceneNodes::Root(parts) if parts.is_empty() => Vec::new(),
            SceneNodes::Root(parts) => {
                nodes.push(top(None, parts));
                vec![nodes.len() as u32 - 1]
            }
            SceneNodes::Elements { elements, .. } => elements
                .into_iter()
                .map(|(name, children)| {
                    nodes.push(top(name, children));
                    nodes.len() as u32 - 1
                })
                .collect(),
        }
    }
}

/// A `GlobalId` worth naming a node by. An absent, empty or blank one leaves
/// the element node unnamed rather than giving it a name no tool can resolve.
fn usable_global_id(global_id: Option<&str>) -> Option<&str> {
    global_id.filter(|g| !g.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(nodes: &[Node], scene: &[u32]) -> Vec<Option<String>> {
        scene.iter().map(|&i| nodes[i as usize].name.clone()).collect()
    }

    #[test]
    fn default_is_one_unnamed_root_over_every_part() {
        let mut s = SceneNodes::new(false);
        for (node, id) in [(0, 7), (1, 7), (2, 9)] {
            s.push(node, id, Some("2O2Fr$t4X7Zf8NOew3FLOH"));
        }
        let mut nodes = Vec::new();
        let scene = s.finish(&mut nodes, Some([1.0, 2.0, 3.0]), None);
        assert_eq!(scene, vec![0]);
        assert_eq!(nodes[0].name, None);
        assert_eq!(nodes[0].children, Some(vec![0, 1, 2]));
        assert_eq!(nodes[0].translation, Some([1.0, 2.0, 3.0]));
    }

    #[test]
    fn issue_9011_groups_parts_by_element_in_first_emitted_order() {
        let mut s = SceneNodes::new(true);
        // A window's frame, a wall, then the window's glass emitted later (the
        // in-memory assembler emits flat parts before instanced ones).
        s.push(10, 5, Some("window"));
        s.push(11, 3, Some("wall"));
        s.push(12, 5, Some("window"));
        let rotation = Some([0.0, 0.5, 0.0, 0.866]);
        let mut nodes = Vec::new();
        let scene = s.finish(&mut nodes, Some([4.0, 5.0, 6.0]), rotation);
        assert_eq!(names(&nodes, &scene), vec![Some("window".into()), Some("wall".into())]);
        assert_eq!(nodes[scene[0] as usize].children, Some(vec![10, 12]));
        assert_eq!(nodes[scene[1] as usize].children, Some(vec![11]));
        for &i in &scene {
            let n = &nodes[i as usize];
            assert_eq!((n.translation, n.rotation), (Some([4.0, 5.0, 6.0]), rotation));
            assert!(n.mesh.is_none() && n.extras.is_none());
        }
    }

    #[test]
    fn issue_9011_element_without_usable_global_id_keeps_an_unnamed_node() {
        let mut s = SceneNodes::new(true);
        s.push(0, 1, None);
        s.push(1, 2, Some(""));
        s.push(2, 3, Some("  "));
        s.push(3, 4, Some("3cUkl32yn9qRSPvBJVyWYp"));
        let mut nodes = Vec::new();
        let scene = s.finish(&mut nodes, None, None);
        assert_eq!(names(&nodes, &scene), vec![None, None, None, Some("3cUkl32yn9qRSPvBJVyWYp".into())]);
    }

    #[test]
    fn issue_9011_a_reused_express_id_does_not_merge_two_elements() {
        // Malformed input: one STEP id on two elements with distinct GlobalIds.
        let mut s = SceneNodes::new(true);
        s.push(0, 500, Some("wall"));
        s.push(1, 500, Some("slab"));
        s.push(2, 500, Some("wall"));
        let mut nodes = Vec::new();
        let scene = s.finish(&mut nodes, None, None);
        assert_eq!(names(&nodes, &scene), vec![Some("wall".into()), Some("slab".into())]);
        assert_eq!(nodes[scene[0] as usize].children, Some(vec![0, 2]));
        assert_eq!(nodes[scene[1] as usize].children, Some(vec![1]));
    }

    #[test]
    fn no_parts_is_an_empty_scene_either_way() {
        for on in [false, true] {
            let mut nodes = Vec::new();
            assert!(SceneNodes::new(on).finish(&mut nodes, Some([1.0; 3]), None).is_empty());
            assert!(nodes.is_empty());
        }
    }
}
