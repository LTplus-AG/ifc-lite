//! Match the loader's coordinate-frame choice before producing f32 meshes.
//! Survey coordinates must not become geometry-loss goldens (#3925).

use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
pub fn router(content: &str, decoder: &mut EntityDecoder) -> GeometryRouter {
    let mut router = GeometryRouter::with_units(content, decoder);
    let mut scan = EntityScanner::new(content);
    let mut jobs = Vec::new();
    let mut site = None;
    while let Some((id, name, start, end)) = scan.next_entity() {
        if name == "IFCSITE" && site.is_none() {
            site = Some((id, start, end));
        }
        if has_geometry_by_name(name) {
            jobs.push((id, start, end, ifc_lite_core::legacy_aware_ifc_type(name)));
        }
    }
    let site_offset = site.and_then(|(id, start, end)| {
        let e = decoder.decode_at_with_id(id, start, end).ok()?;
        let m = router.resolve_scaled_placement(&e, decoder).ok()?;
        let t = (m[12], m[13], m[14]);
        (t.0.abs() > 1e-9 || t.1.abs() > 1e-9 || t.2.abs() > 1e-9).then_some(t)
    });
    let offset = site_offset.unwrap_or_else(|| {
        router.detect_rtc_offset_with_fallback(&jobs, decoder, content.as_bytes())
    });
    router.set_rtc_offset(offset);
    router
}
