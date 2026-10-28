// SPDX-License-Identifier: MPL-2.0
//! M4 gates each capped band and its sum against independent IFC integrals.
pub(super) fn check(product: &super::ShapeOnlyProduct, sources: &super::AnalyticQuantitySources,
    bytes: &[u8], tolerances: &serde_json::Value) -> Vec<super::OracleResult> {
    if !product.parts.iter().any(|p|p.layer.is_some()) {return Vec::new();}
    let Some(expected)=ifc_lite_retained_native::oracle::layers::expected(bytes,sources,product.product_id) else {
        return vec![super::OracleResult{family:"layerSourceAvailable",value:1.,limit:0.,pass:false,gated:true}];
    };
    let key=if expected.curved {"curved"} else {"linear"};
    let mut results=Vec::new(); let mut sum=0.;
    for part in &product.parts {
        let volume=part.capped_volume_m3.unwrap_or(f64::INFINITY);
        sum+=volume;
        let expected=part.layer.and_then(|l|expected.volumes.get(usize::from(l.index))).copied().unwrap_or(f64::NAN);
        let value=super::super::metrics::relative(volume,expected);
        let limit=tolerances["layerBandVolumeRelative"][key].as_f64().unwrap_or(0.);
        results.push(super::OracleResult{family:"layerBandVolumeRelative",value,limit,pass:value<=limit,gated:true});
    }
    let value=super::super::metrics::relative(sum,expected.opened_volume);
    let limit=tolerances["layerBandSumRelative"][key].as_f64().unwrap_or(0.);
    results.push(super::OracleResult{family:"layerBandSumRelative",value,limit,pass:value<=limit,gated:true});
    let limit=tolerances["layerCapWeldMetres"][key].as_f64().unwrap_or(0.);
    results.push(super::OracleResult{family:"layerCapWeldMetres",value:product.max_snap_metres,limit,pass:product.max_snap_metres<=limit,gated:true});
    results
}
