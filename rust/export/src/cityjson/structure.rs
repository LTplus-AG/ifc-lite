// SPDX-License-Identifier: MPL-2.0
//! Which IFC products become which CityJSON City Objects, and under which
//! parent.
//!
//! The IFC spatial tree (`IfcRelAggregates` plus
//! `IfcRelContainedInSpatialStructure`, see [`crate::relationships`]) is
//! walked from the project. CityJSON 2.0 (spec §2.3) constrains it in two
//! ways that shape the mapping:
//!
//! * an installation, constructive element, piece of furniture or storey may
//!   only have a `Building`, `BuildingPart` or `BuildingRoom` as parent, so
//!   a `BuildingStorey` cannot hold the elements IFC contains in it. Storey
//!   membership is kept as the `ifcBuildingStorey` attribute instead;
//! * a constructive element cannot be the parent of another, so IFC
//!   decomposition below an element (stair flights, curtain-wall panels,
//!   assembly parts) is flattened to the element's own parent.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::IfcType;

/// The CityJSON type a product maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Building,
    BuildingPart,
    Storey,
    Room,
    Constructive,
    Installation,
    Furniture,
}

impl Kind {
    pub(super) fn city_type(self) -> &'static str {
        match self {
            Kind::Building => "Building",
            Kind::BuildingPart => "BuildingPart",
            Kind::Storey => "BuildingStorey",
            Kind::Room => "BuildingRoom",
            Kind::Constructive => "BuildingConstructiveElement",
            Kind::Installation => "BuildingInstallation",
            Kind::Furniture => "BuildingFurniture",
        }
    }

    /// Whether the product's meshes describe the building's outer form, so
    /// count toward its LoD0 footprint and LoD1 block.
    pub(super) fn shapes_building(self) -> bool {
        matches!(self, Kind::Constructive | Kind::Installation)
    }
}

/// One product placed in the CityJSON hierarchy.
#[derive(Debug, Clone)]
pub(super) struct Node {
    pub id: u32,
    pub kind: Kind,
    /// The express id of the CityJSON parent (a building, part or room).
    pub parent: Option<u32>,
    /// The `IfcBuildingStorey` the product sits in, if any.
    pub storey: Option<u32>,
    /// Every `Building`/`BuildingPart` the product is (transitively) inside,
    /// innermost first; empty for a top-level building.
    pub containers: Vec<u32>,
}

/// The walked hierarchy, in walk order (parents before children).
pub(super) struct Structure {
    pub nodes: Vec<Node>,
    /// Elements found in the spatial tree outside every building.
    pub outside_buildings: usize,
}

#[derive(Clone, Default)]
struct Ctx {
    parent: Option<u32>,
    storey: Option<u32>,
    containers: Vec<u32>,
}

/// The CityJSON kind of an element (an `IfcElement` occurrence), or `None`
/// for one that is not building geometry (openings, virtual elements).
pub(super) fn element_kind(t: &IfcType) -> Option<Kind> {
    let is = |parent: IfcType| t.is_subtype_of(parent);
    if is(IfcType::IfcFeatureElement) || is(IfcType::IfcVirtualElement) {
        return None;
    }
    if is(IfcType::IfcFurnishingElement) {
        return Some(Kind::Furniture);
    }
    if is(IfcType::IfcDistributionElement)
        || is(IfcType::IfcRailing)
        || is(IfcType::IfcShadingDevice)
        || is(IfcType::IfcChimney)
        || is(IfcType::IfcTransportElement)
        || is(IfcType::IfcBuildingElementProxy)
    {
        return Some(Kind::Installation);
    }
    if is(IfcType::IfcBuildingElement) || is(IfcType::IfcBuiltElement) || is(IfcType::IfcElementAssembly) || is(IfcType::IfcElementComponent) {
        return Some(Kind::Constructive);
    }
    is(IfcType::IfcElement).then_some(Kind::Installation)
}

/// Walk the spatial tree from `project`. `type_of` names each product's
/// class; `children` is the merged aggregation/containment map.
pub(super) fn walk(project: Option<u32>, children: &HashMap<u32, Vec<u32>>, type_of: &HashMap<u32, IfcType>) -> Structure {
    let mut out = Structure { nodes: Vec::new(), outside_buildings: 0 };
    // A tree in a valid file; the visited set bounds a malformed one (a
    // product aggregated twice, or a cycle) to one visit per product.
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack: Vec<(u32, Ctx)> = Vec::new();
    let mut roots: Vec<u32> = project.into_iter().collect();
    // A file without a project (malformed, but seen) still exports its
    // buildings: every product that is nobody's child is a root.
    if roots.is_empty() {
        let child_ids: HashSet<u32> = children.values().flatten().copied().collect();
        let mut orphans: Vec<u32> = type_of.keys().copied().filter(|id| !child_ids.contains(id)).collect();
        orphans.sort_unstable();
        roots = orphans;
    }
    for root in roots.into_iter().rev() {
        stack.push((root, Ctx::default()));
    }
    while let Some((id, ctx)) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        // A non-product (the project) or an unreadable id: walked through.
        let Some(t) = type_of.get(&id) else {
            if let Some(kids) = children.get(&id) {
                for &kid in kids.iter().rev() {
                    stack.push((kid, ctx.clone()));
                }
            }
            continue;
        };
        let in_building = !ctx.containers.is_empty();
        let mut next = ctx.clone();
        let mut descend = true;
        if t.is_subtype_of(IfcType::IfcBuilding) {
            let kind = if in_building { Kind::BuildingPart } else { Kind::Building };
            out.nodes.push(Node { id, kind, parent: ctx.containers.first().copied(), storey: None, containers: ctx.containers.clone() });
            next.parent = Some(id);
            next.storey = None;
            next.containers.insert(0, id);
        } else if in_building && t.is_subtype_of(IfcType::IfcBuildingStorey) {
            out.nodes.push(Node { id, kind: Kind::Storey, parent: ctx.containers.first().copied(), storey: None, containers: ctx.containers.clone() });
            next.storey = Some(id);
        } else if in_building && t.is_subtype_of(IfcType::IfcSpace) {
            out.nodes.push(Node { id, kind: Kind::Room, parent: ctx.containers.first().copied(), storey: ctx.storey, containers: ctx.containers.clone() });
            next.parent = Some(id);
        } else if t.is_subtype_of(IfcType::IfcElement) {
            match (in_building, element_kind(t)) {
                (true, Some(kind)) => {
                    out.nodes.push(Node { id, kind, parent: ctx.parent, storey: ctx.storey, containers: ctx.containers.clone() });
                }
                (true, None) => descend = false,
                (false, Some(_)) => out.outside_buildings += 1,
                (false, None) => descend = false,
            }
        }
        if descend {
            if let Some(kids) = children.get(&id) {
                for &kid in kids.iter().rev() {
                    stack.push((kid, next.clone()));
                }
            }
        }
    }
    out
}
