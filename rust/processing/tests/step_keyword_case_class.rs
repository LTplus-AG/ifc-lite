// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! STEP keyword case is not significant (ISO 10303-21), and
//! `EntityScanner::next_entity` hands back the keyword exactly as the file
//! wrote it. Every scan loop that compared that raw slice against an
//! uppercase literal with `==` silently dropped whatever it indexed on a
//! lowercase- or CamelCase-keyword file: #4497 fixed two decoder sites and
//! left the rest. This pins the CLASS rather than one site per test: the
//! determinism fixture (voids, styles, a material chain) plus a spatial tree,
//! processed once with the keywords as authored and once per recasing, must
//! come out identical in every surface a case-sensitive arm feeds. Before the
//! fix the recased runs lost both `IfcRelVoidsElement` cuts (each wall came
//! back an uncut 12-triangle box), the styled-item colour, the material
//! colours, the site and building transforms and the whole spatial tree.
//!
//! A second test pins that the sharded browser classifier
//! (`classify_type_name`) agrees with the serial scan on recased keywords,
//! since the two are independent tables and the wasm viewer takes the
//! sharded path.

use ifc_lite_processing::determinism::FIXTURE_IFC;
use ifc_lite_processing::{
    classify_type_name, process_geometry_streaming_with_options_and_bootstrap,
    QuickMetadataBootstrap, QuickMetadataSpatialNode, StreamingOptions,
    PREPASS_CLASS_NONE,
};

/// The determinism fixture carries no spatial tree; append one so the
/// quick-metadata bootstrap (`IFCPROJECT` / `IFCSITE` / `IFCBUILDING` /
/// `IFCRELAGGREGATES` / `IFCRELCONTAINEDINSPATIALSTRUCTURE` arms) is exercised too.
fn fixture_with_spatial_tree() -> String {
    const TREE: &str = "\
#900=IFCSITE('0DeterminismSite0000A',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#901=IFCBUILDING('0DeterminismBldg0000A',$,'Building',$,$,#20,$,$,.ELEMENT.,$,$,$);
#902=IFCBUILDINGSTOREY('0DeterminismStorey00A',$,'Level 1',$,$,#20,$,$,.ELEMENT.,0.);
#910=IFCRELAGGREGATES('0DeterminismAggPS000A',$,$,$,#1,(#900));
#911=IFCRELAGGREGATES('0DeterminismAggSB000A',$,$,$,#900,(#901));
#912=IFCRELAGGREGATES('0DeterminismAggBS000A',$,$,$,#901,(#902));
#913=IFCRELCONTAINEDINSPATIALSTRUCTURE('0DeterminismCont000A',$,$,$,(#100,#400,#500,#600),#902);
";
    FIXTURE_IFC.replacen("ENDSEC;\nEND-ISO", &format!("{TREE}ENDSEC;\nEND-ISO"), 1)
}

/// Rewrite every DATA-section keyword (`#N=KEYWORD(`) through `recase`,
/// leaving ids, attributes and the HEADER untouched.
fn recase_keywords(ifc: &str, recase: impl Fn(&str) -> String) -> String {
    ifc.lines()
        .map(|line| {
            let Some(rest) = line.strip_prefix('#') else {
                return line.to_string();
            };
            let (Some(eq), Some(paren)) = (rest.find('='), rest.find('(')) else {
                return line.to_string();
            };
            if paren < eq {
                return line.to_string();
            }
            let keyword = &rest[eq + 1..paren];
            format!("#{}={}{}", &rest[..eq], recase(keyword), &rest[paren..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn lowercase(keyword: &str) -> String {
    keyword.to_ascii_lowercase()
}

/// `IFCRELVOIDSELEMENT` -> `Ifcrelvoidselement`, the CamelCase-ish shape the
/// #4497 report came in with. Inputs are uppercase ASCII keywords.
fn capitalised(keyword: &str) -> String {
    format!("{}{}", &keyword[..1], keyword[1..].to_ascii_lowercase())
}

/// `IfCrElVoIdSeLeMeNt`: no per-file convention a heuristic could detect.
fn alternating(keyword: &str) -> String {
    keyword
        .chars()
        .enumerate()
        .map(|(i, c)| {
            if i % 2 == 0 {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect()
}

/// One mesh with its float surfaces as bits, so it derives `Eq` and `Ord`.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Mesh {
    express_id: u32,
    geometry_item_id: Option<u32>,
    ifc_type: String,
    positions: Vec<u32>,
    normals: Vec<u32>,
    indices: Vec<u32>,
    color: [u32; 4],
    material_name: Option<String>,
}

/// Everything the scan loop's keyword arms feed, in a form that compares.
#[derive(Debug, PartialEq)]
struct Surface {
    meshes: Vec<Mesh>,
    site_transform: Option<Vec<u64>>,
    building_transform: Option<Vec<u64>>,
    length_unit_scale: Option<u64>,
    entity_count: usize,
    geometry_entity_count: usize,
    spatial_tree: Option<Tree>,
}

/// The bootstrap tree with its `type_name` case-folded: the node label is the
/// raw keyword and is allowed to differ; the SHAPE is not.
#[derive(Debug, PartialEq)]
struct Tree {
    express_id: u32,
    type_name: String,
    elevation: Option<u64>,
    children: Vec<Tree>,
    elements: Vec<u32>,
}

fn tree(node: &QuickMetadataSpatialNode) -> Tree {
    Tree {
        express_id: node.summary.express_id,
        type_name: node.summary.type_name.to_ascii_uppercase(),
        elevation: node.summary.elevation.map(f64::to_bits),
        children: node.children.iter().map(tree).collect(),
        elements: node.elements.iter().map(|e| e.express_id).collect(),
    }
}

fn surface(ifc: &str) -> Surface {
    let mut bootstrap: Option<QuickMetadataBootstrap> = None;
    let result = process_geometry_streaming_with_options_and_bootstrap(
        ifc.as_bytes(),
        StreamingOptions {
            emit_quick_metadata_bootstrap: true,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |b| bootstrap = Some(b.clone()),
    );
    let mut meshes: Vec<_> = result
        .meshes
        .iter()
        .map(|m| Mesh {
            express_id: m.express_id,
            geometry_item_id: m.geometry_item_id,
            ifc_type: m.ifc_type.clone(),
            positions: m.positions.iter().map(|v| v.to_bits()).collect(),
            normals: m.normals.iter().map(|v| v.to_bits()).collect(),
            indices: m.indices.clone(),
            color: m.color.map(f32::to_bits),
            material_name: m.material_name.clone(),
        })
        .collect();
    meshes.sort();
    let bits = |t: &Option<Vec<f64>>| t.as_ref().map(|v| v.iter().map(|x| x.to_bits()).collect());
    Surface {
        meshes,
        site_transform: bits(&result.site_transform),
        building_transform: bits(&result.building_transform),
        length_unit_scale: result.metadata.length_unit_scale.map(f64::to_bits),
        entity_count: result.metadata.entity_count,
        geometry_entity_count: result.metadata.geometry_entity_count,
        spatial_tree: bootstrap
            .expect("quick metadata bootstrap was requested")
            .spatial_tree
            .as_ref()
            .map(tree),
    }
}

/// The uppercase run must actually exercise every surface the recased runs
/// are compared on, or the equality below could hold with all of them empty.
fn assert_fixture_exercises_the_class(upper: &Surface) {
    let tris = |id: u32| -> usize {
        upper
            .meshes
            .iter()
            .filter(|m| m.express_id == id)
            .map(|m| m.indices.len() / 3)
            .sum()
    };
    // A box is 12 triangles; a wall with an opening cut through it is more.
    assert!(tris(100) > 12, "wall #100 was not voided: {} triangles", tris(100));
    assert!(tris(600) > 12, "wall #600 was not voided: {} triangles", tris(600));
    // The geometry-attached IfcStyledItem #530 colours the column concrete.
    let column = upper.meshes.iter().find(|m| m.express_id == 500).expect("column #500 meshed");
    assert_eq!(
        column.color.map(f32::from_bits).map(|c| (c * 100.0).round() / 100.0),
        [0.62, 0.6, 0.55, 1.0],
        "column #500 did not take its styled-item colour"
    );
    // The #407 material chain (IfcRelAssociatesMaterial -> IfcMaterialList ->
    // IfcMaterialDefinitionRepresentation -> orphan IfcStyledItem) paints the
    // proxy #400 with its first material, the half-transparent Glazing.
    let proxy = upper.meshes.iter().find(|m| m.express_id == 400).expect("proxy #400 meshed");
    assert_eq!(
        proxy.color.map(f32::from_bits).map(|c| (c * 100.0).round() / 100.0),
        [0.2, 0.4, 0.8, 0.5],
        "proxy #400 did not take its material colour"
    );
    assert!(upper.site_transform.is_some(), "no IfcSite transform");
    assert!(upper.building_transform.is_some(), "no IfcBuilding transform");
    let root = upper.spatial_tree.as_ref().expect("spatial tree");
    assert_eq!(root.express_id, 1, "root must be the IfcProject");
    let storey = &root.children[0].children[0].children[0];
    assert_eq!(storey.express_id, 902);
    assert_eq!(storey.elements, vec![100, 400, 500, 600]);
}

#[test]
fn recased_keywords_process_identically_to_uppercase() {
    let upper_ifc = fixture_with_spatial_tree();
    let upper = surface(&upper_ifc);
    assert_fixture_exercises_the_class(&upper);

    for (label, recase) in [
        ("lowercase", lowercase as fn(&str) -> String),
        ("capitalised", capitalised),
        ("alternating", alternating),
    ] {
        let recased_ifc = recase_keywords(&upper_ifc, recase);
        assert_ne!(recased_ifc, upper_ifc, "{label}: recasing changed nothing");
        let recased = surface(&recased_ifc);
        assert_eq!(
            recased, upper,
            "{label}-keyword file processed differently from the uppercase original"
        );
    }
}

/// The sharded browser pre-pass classifies each record by keyword in
/// `classify_type_name`, a table independent of the serial scan loop. Both
/// must accept recased keywords, or native and wasm diverge on the same file.
#[test]
fn shard_classifier_is_keyword_case_insensitive() {
    let keywords = [
        "IFCPROJECT",
        "IFCSITE",
        "IFCSTYLEDITEM",
        "IFCINDEXEDCOLOURMAP",
        "IFCMATERIALDEFINITIONREPRESENTATION",
        "IFCRELASSOCIATESMATERIAL",
        "IFCRELVOIDSELEMENT",
        "IFCRELFILLSELEMENT",
        "IFCRELAGGREGATES",
        "IFCMAPPEDITEM",
        "IFCRELDEFINESBYTYPE",
        "IFCMATERIALLAYERSET",
        "IFCMATERIALLAYERSETUSAGE",
        "IFCWALLTYPE",
        "IFCWALL",
    ];
    for keyword in keywords {
        let expected = classify_type_name(keyword);
        assert_ne!(expected, PREPASS_CLASS_NONE, "{keyword} must classify as something");
        for recased in [lowercase(keyword), capitalised(keyword), alternating(keyword)] {
            let got = classify_type_name(&recased);
            assert_eq!(
                got, expected,
                "{recased}: class byte {got:#04x} differs from {keyword}'s {expected:#04x}"
            );
        }
    }
}
