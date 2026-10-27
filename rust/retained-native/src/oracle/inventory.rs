// SPDX-License-Identifier: MPL-2.0
//! Every opening is accounted for, including representations without quantities.
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::AnalyticQuantitySources;
#[derive(Debug, Default)]
pub struct OpeningInventory {
    pub supported_extrusions: Vec<u32>,
    pub no_analytic_quantities: Vec<u32>,
}
/// `IfcOpeningElement` and its IFC4 subtype `IfcOpeningStandardCase`.
pub fn is_opening(entity: &str) -> bool {
    entity.eq_ignore_ascii_case("IFCOPENINGELEMENT")
        || entity.eq_ignore_ascii_case("IFCOPENINGSTANDARDCASE")
}
pub fn opening_inventory(bytes: &[u8], sources: &AnalyticQuantitySources) -> OpeningInventory {
    let mut result = OpeningInventory::default();
    let mut scanner = EntityScanner::new(bytes);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if !is_opening(name) {
            continue;
        }
        let has_quantities = sources
            .extrusion_definitions
            .instances
            .get(&id)
            .is_some_and(|instances| {
                !instances.is_empty()
                    && super::quantities::expected(sources, id, instances.len()).is_some()
            });
        if has_quantities {
            result.supported_extrusions.push(id);
        } else {
            result.no_analytic_quantities.push(id);
        }
    }
    result.supported_extrusions.sort_unstable();
    result.no_analytic_quantities.sort_unstable();
    result
}
