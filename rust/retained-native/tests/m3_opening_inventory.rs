// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[allow(dead_code)]
#[path = "../examples/compare/options.rs"]
mod options;
#[allow(dead_code)]
#[path = "../examples/compare/registry.rs"]
mod registry;
use ifc_lite_processing::extract_analytic_quantity_sources;
use ifc_lite_retained_native::oracle::inventory::{is_opening, opening_inventory};

// #7955 M3-0: supported opening membership, not merely a host-only assertion.
// The M3 base membership stays pinned. Every slice addition must also satisfy
// the exhaustive, disjoint classification invariant below (#7955 CUT-0).
#[test]
fn every_committed_opening_has_an_explicit_quantity_classification() {
    let pins = [
        (
            "issue_2019_wall_two_overlapping_openings.ifc",
            vec![50, 70, 100],
            0,
        ),
        ("issue_3641_voiding_trap.ifc", vec![], 0), // IfcVoidingFeature, not OpeningElement.
        ("f-a-curved.ifc", vec![63, 129, 195, 261], 0),
        ("f-b-mapped.ifc", vec![135, 160], 0),
        ("issue_098_wall_W.ifc", vec![], 7), // All seven Body items are IfcFacetedBrep.
        ("f-c-extrusion.ifc", vec![], 0),
        ("f-c-brep.ifc", vec![], 0),
        ("layered-wall.ifc", vec![], 0),
        ("mapped_instances_synthetic.ifc", vec![], 0),
        ("mapped_instances_multi_item.ifc", vec![], 0),
        ("mapped_instances_site_rotated.ifc", vec![], 0),
        ("swept_disk_trimmed_line.ifc", vec![], 0),
        ("issue_1985_scaled_kinds.ifc", vec![], 0),
        ("bath_csg_solid.ifc", vec![], 0),
        // #7955 M9 expands the corpus: #85/#95 are mapped extrusion openings;
        // the #4560 cutters are Boolean operands, not IfcOpeningElement entities.
        ("issue_6446_mapped_source_frames.ifc", vec![85, 95], 0),
        ("issue_4560_wall_roof_polygonal_cutters.ifc", vec![], 0),
    ];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let base = options::base_models();
    assert_eq!(pins.len(), base.len());
    for path in base {
        let name = std::path::Path::new(path).file_name().unwrap().to_str().unwrap();
        assert!(pins.iter().any(|p| p.0 == name), "base fixture needs a reviewed count");
    }
    for path in options::committed_models(&root).expect("valid per-slice universe") {
        let name = std::path::Path::new(&path).file_name().unwrap().to_str().unwrap();
        let bytes = std::fs::read(root.join(&path)).expect("committed fixture missing");
        let sources = extract_analytic_quantity_sources(&bytes, None);
        let inventory = opening_inventory(&bytes, &sources);
        if let Some((_, supported, unsupported)) = pins.iter().find(|p| p.0 == name) {
            assert_eq!(&inventory.supported_extrusions, supported, "{path}");
            assert_eq!(inventory.no_analytic_quantities.len(), *unsupported, "{path}");
        }
        let mut scanner = ifc_lite_core::EntityScanner::new(&bytes);
        let mut all = std::collections::BTreeSet::new();
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if is_opening(name) {
                all.insert(id);
            }
        }
        let mut classified = std::collections::BTreeSet::new();
        for id in inventory
            .supported_extrusions
            .iter()
            .chain(&inventory.no_analytic_quantities)
        {
            assert!(classified.insert(*id), "opening in both partitions");
        }
        assert_eq!(classified, all, "{path}: silent omission");
        for id in &inventory.no_analytic_quantities {
            assert!(!sources.extrusion_definitions.instances.contains_key(id));
            assert!(!sources.swept_disk_definitions.instances.contains_key(id));
            eprintln!("{path}: opening #{id}: no analytic quantities");
        }
    }
}

// The IFC4 subtype is an opening too; it must be classified, never skipped.
#[test]
fn opening_standard_case_is_inventoried() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
    let text = std::fs::read_to_string(path).expect("committed fixture missing");
    assert_eq!(text.matches("IFCOPENINGELEMENT(").count(), 3);
    let bytes = text
        .replace("FILE_SCHEMA(('IFC2X3'))", "FILE_SCHEMA(('IFC4'))")
        .replace("IFCOPENINGELEMENT(", "IFCOPENINGSTANDARDCASE(")
        .into_bytes();
    let sources = extract_analytic_quantity_sources(&bytes, None);
    let inventory = opening_inventory(&bytes, &sources);
    let mut all: Vec<_> = inventory
        .supported_extrusions
        .iter()
        .chain(&inventory.no_analytic_quantities)
        .copied()
        .collect();
    all.sort_unstable();
    assert_eq!(all, vec![50, 70, 100]);
}
