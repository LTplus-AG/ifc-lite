// SPDX-License-Identifier: MPL-2.0
pub use ifc_lite_retained_native::oracle::quantities::expected;

/// The authored #3641 spur has no ordinary analytic quantity. Its independent
/// region oracle is mandatory before exact metrics become report-only (M8).
pub fn retraced(
    model: &std::path::Path,
    sources: &ifc_lite_processing::AnalyticQuantitySources,
    decoder: &mut ifc_lite_core::EntityDecoder,
    tolerances: &serde_json::Value,
) -> Result<Option<(f64, Option<[f64; 6]>)>, &'static str> {
    if model != std::path::Path::new("rust/processing/tests/fixtures/issue_3641_voiding_trap.ifc") {
        return Ok(None);
    }
    let relative = tolerances["retraceAreaRelative"].as_f64().ok_or("M8 area tolerance absent")?;
    if tolerances["voidingExactComparison"] != "report only"
        || tolerances["convexLeafVolumeRelative"]["linear"] != tolerances["sourceVolumeRelative"]["linear"] {
        return Err("M8 comparison policy differs from preregistration");
    }
    let frame = sources.extrusion_definitions.instances.get(&72245)
        .and_then(|instances| instances.first()).and_then(|instance| instance.world_from_source)
        .ok_or("M8 source placement absent")?;
    let origin = [frame[12], frame[13], frame[14]];
    let region = ifc_lite_retained_native::oracle::retrace::source(sources, decoder, origin, relative)
        .ok_or("oracle cannot model this profile")?;
    let mut bounds = region.bbox();
    for i in 0..3 { bounds[i] += origin[i]; bounds[i + 3] += origin[i]; }
    Ok(Some((region.volume(), Some(bounds))))
}
