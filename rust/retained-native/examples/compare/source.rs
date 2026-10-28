// SPDX-License-Identifier: MPL-2.0
pub use ifc_lite_retained_native::oracle::quantities::expected;
type SourceExpectation = (f64, Option<[f64; 6]>);

/// The authored #3641 spur has no ordinary analytic quantity. Its independent
/// region oracle is mandatory before exact metrics become report-only (M8).
pub fn retraced(
    model: &std::path::Path,
    sources: &ifc_lite_processing::AnalyticQuantitySources,
    decoder: &mut ifc_lite_core::EntityDecoder,
    tolerances: &serde_json::Value,
) -> Result<Option<SourceExpectation>, &'static str> {
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

/// M8's arbitrarily oriented, overlapping three-cut chain needs the convex
/// inclusion/exclusion oracle rather than M3's parallel-prism oracle.
pub fn retraced_opening(
    model: &std::path::Path,
    sources: &ifc_lite_processing::AnalyticQuantitySources,
    decoder: &mut ifc_lite_core::EntityDecoder,
    tolerances: &serde_json::Value,
) -> Result<Option<ifc_lite_retained_native::oracle::openings::OpeningExpectation>, &'static str> {
    use ifc_lite_retained_native::oracle::{convex, retrace, openings::OpeningExpectation};
    if model != std::path::Path::new("rust/processing/tests/fixtures/issue_3641_voiding_trap.ifc") {
        return Ok(None);
    }
    // Reuse the existing opening gate only while its thresholds are exactly
    // the independently preregistered M8 thresholds. No tolerance fallback.
    if tolerances["convexDifferenceVolumeRelative"]["linear"] != tolerances["openingPrismVolumeRelative"]["linear"]
        || tolerances["voidingResultBboxWithinHost"] != tolerances["openingResultBboxWithinHost"] {
        return Err("M8 opening comparison policy differs from preregistration");
    }
    let relative = tolerances["retraceAreaRelative"].as_f64().ok_or("M8 area tolerance absent")?;
    let frame = sources.extrusion_definitions.instances.get(&72209)
        .and_then(|instances| instances.first()).and_then(|instance| instance.world_from_source)
        .ok_or("M8 host placement absent")?;
    let origin = [frame[12], frame[13], frame[14]];
    let host = convex::source(sources, 72209, origin).ok_or("M8 host oracle absent")?;
    let cutters = [
        convex::source(sources, 72216, origin).ok_or("M8 rectangle oracle absent")?,
        convex::source(sources, 72230, origin).ok_or("M8 polygon oracle absent")?,
        retrace::source(sources, decoder, origin, relative).ok_or("M8 retrace oracle absent")?,
    ];
    let volume = convex::difference_volume(&host, &cutters).ok_or("M8 cut oracle absent")?;
    let mut bbox = host.bbox();
    for i in 0..3 { bbox[i] += origin[i]; bbox[i+3] += origin[i]; }
    Ok(Some(OpeningExpectation {
        nominal_host_volume: host.volume(), result_volume: Some(volume),
        volume_bounds: [volume, host.volume()], host_bbox: Some(bbox), curved: false,
    }))
}
