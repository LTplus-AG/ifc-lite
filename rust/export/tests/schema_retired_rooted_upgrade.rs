// SPDX-License-Identifier: MPL-2.0

use ifc_lite_export::{export_step_with_diagnostics, StepOptions};

#[test]
fn retired_property_and_circuit_references_11324() {
    let source = include_bytes!("fixtures/schema_retired_rooted_upgrade.ifc");
    for schema in ["IFC4", "IFC4X3"] {
        let options = StepOptions { schema: Some(schema.into()), ..Default::default() };
        let (output, _, warnings) = export_step_with_diagnostics(source, &options).unwrap();
        for id in ["#7=", "#8="] {
            assert!(!output.lines().any(|line| line.starts_with(id)), "{output}");
        }
        for record in ["#9=IFCDISTRIBUTIONCIRCUIT(", "#10=IFCRELASSIGNSTOGROUP(", "#13=IFCRELDEFINESBYPROPERTIES("] {
            assert!(output.contains(record), "{output}");
        }
        for entity in ["IFCENERGYPROPERTIES", "IFCRELDEFINESBYPROPERTIES"] {
            assert!(warnings.iter().any(|w| w.contains(entity) && w.contains("omitted")), "{warnings:?}");
        }
    }
}
