// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[allow(dead_code)]
#[path = "../examples/compare/options.rs"]
mod options;
use ifc_lite_processing::extract_analytic_quantity_sources;
use ifc_lite_retained_native::oracle::inventory::opening_inventory;

// #7955 M3-0: supported opening membership, not merely a host-only assertion.
// The complete universe is pinned: adding a fixture requires an explicit count.
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
    ];
    assert_eq!(pins.len(), options::committed_models().len());
    for path in options::committed_models() {
        let name = std::path::Path::new(path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let (_, supported, unsupported) = pins
            .iter()
            .find(|p| p.0 == name)
            .expect("new fixture needs a reviewed count");
        let absolute = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path);
        let bytes = std::fs::read(absolute).expect("committed fixture missing");
        let sources = extract_analytic_quantity_sources(&bytes, None);
        let inventory = opening_inventory(&bytes, &sources);
        assert_eq!(&inventory.supported_extrusions, supported, "{path}");
        assert_eq!(
            inventory.no_analytic_quantities.len(),
            *unsupported,
            "{path}"
        );
        let mut scanner = ifc_lite_core::EntityScanner::new(&bytes);
        let mut all = std::collections::BTreeSet::new();
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if name.eq_ignore_ascii_case("IFCOPENINGELEMENT") {
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
