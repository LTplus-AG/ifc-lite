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

/// A face-set host has no analytic prism, so its cut comes from the fixture's
/// hand-specified table. An unlisted host stays unverified and fails closed (#8291).
pub fn face_set_openings(model: &std::path::Path) -> Result<Vec<(u32, ifc_lite_retained_native::oracle::openings::OpeningExpectation)>, String> {
    use ifc_lite_retained_native::oracle::openings::OpeningExpectation;
    let (file, oracle) = match model.to_str() {
        Some("tests/fixtures/synthetic-retained/f-b-mapped.ifc") => ("f-b-mapped.ifc", "oracles.json"),
        Some("tests/fixtures/synthetic-retained/f-t-face-set-presentation.ifc") => ("f-t-face-set-presentation.ifc", "f-t-face-set-presentation.oracle.json"),
        _ => return Ok(Vec::new()),
    };
    let table = std::fs::read_to_string(format!("tests/fixtures/synthetic-retained/{oracle}")).map_err(|e| e.to_string())?;
    let table: serde_json::Value = serde_json::from_str(&table).map_err(|e| e.to_string())?;
    let products = table["cases"][file]["products"].as_array().ok_or("face-set oracle products absent")?;
    Ok(products.iter().filter(|p| p["opening_id"].is_u64()).map(|p| {
        let (volume, opening) = (p["volume"].as_f64().unwrap_or(f64::NAN), p["opening_volume"].as_f64().unwrap_or(f64::NAN));
        (p["id"].as_u64().unwrap_or(0) as u32, OpeningExpectation { nominal_host_volume: volume + opening,
            volume_bounds: [volume, volume + opening], result_volume: Some(volume), host_bbox: None, curved: false })
    }).collect())
}

/// A closed face-set product's solid volume from its authored rows: exact's f32 storage
/// cannot measure a small shell at survey scale, so this is what outranks it (#8291).
pub fn face_set_volume(shape: &ifc_lite_retained_native::ShapeOnlyProduct, bytes: &[u8]) -> Option<SourceExpectation> {
    use ifc_lite_retained_native::oracle::face_sets;
    let mut decoder = ifc_lite_core::EntityDecoder::new(bytes);
    let units = ifc_lite_geometry::GeometryRouter::with_units(bytes, &mut decoder).unit_scale();
    let mut volume = 0.;
    for part in &shape.parts {
        let key = part.faces.as_ref().filter(|_| part.source_exact)?.table.first()?;
        let item = decoder.decode_by_id(key.item).ok()?;
        volume += face_sets::authored_volume(&face_sets::authored(&item, &mut decoder, units)?)?;
    }
    Some((volume, None))
}
