// SPDX-License-Identifier: MPL-2.0
//! #7955 / #8285: per-item styling in the mesh funnel can mask a wrong job colour.
//! Pin the cached job resolver itself against the same authored IFC sources as m11_a_appearance.
use super::{AppearanceResolver, EntityJob};
use crate::prepass::{resolve_prepass, PrepassSpans};
use ifc_lite_core::{EntityScanner, IfcType};

#[path = "../../tests/common/m11_a_source.rs"]
mod fixture;

#[test]
fn m11_a_7955_job_style_precedes_material_and_material_precedes_type_default() {
    for direct in [true, false] {
        let source = fixture::precedence_source(direct);
        let mut decoder = source.decoder();
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(source.bytes());
        while let Some((id, name, start, end)) = scanner.next_entity() {
            spans.stash(name, id, start, end);
        }
        let resolved = resolve_prepass(&spans, &mut decoder, Default::default());
        let materials = resolved.element_material_colors.iter().filter_map(|(&id, colors)| {
            crate::style::element_material_fallback_color(colors).map(|color| (id, color))
        }).collect();
        let mut resolver = AppearanceResolver::new(materials, Default::default(), false);
        let entity = decoder.decode_by_id(14).unwrap();
        // The span is unused by identity/appearance; both read the real decoded product.
        let mut job = EntityJob::new(14, IfcType::IfcWall, 0, 0);
        job.set_identity(&entity);
        let expected: [f32; 4] = if direct { [0.2, 0.4, 0.6, 0.7] } else { [0.9, 0.8, 0.1, 1.] };
        // A second resolution exercises the per-shape cache too.
        for _ in 0..2 {
            job.element_color = fixture::WALL_GREY;
            resolver.resolve(&mut job, &resolved.geometry_style_index, &mut decoder);
            assert_eq!(job.element_color.map(f32::to_bits), expected.map(f32::to_bits), "direct={direct}");
        }
    }
}
