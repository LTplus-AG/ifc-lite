// SPDX-License-Identifier: MPL-2.0
use super::metrics::{bbox_deviation, relative, Metrics};
use ifc_lite_retained_native::ShapeOnlyProduct;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Report {
    pub candidates: usize,
    pub published: usize,
    pub histogram: BTreeMap<String, usize>,
    pub violations: Vec<String>,
    pub universe_mismatch: Vec<String>,
    pub skipped: Vec<String>,
    pub maxima: [f64; 4],
    pub exact_ms: f64,
    pub retained_ms: f64,
    pub rows: Vec<String>,
    pub coverage: Vec<String>,
    pub models: Vec<Value>,
}
impl Report {
    // One comparison row combines both independently measured sides and source expectations.
    #[allow(clippy::too_many_arguments)]
    pub fn published(
        &mut self,
        model: &str,
        shape: &ShapeOnlyProduct,
        actual: &Metrics,
        exact: Option<&Metrics>,
        source: Option<(f64, Option<[f64; 6]>)>,
        tolerances: &Value,
        ms: f64,
    ) {
        self.published += 1;
        let curved = shape.parts.iter().any(|p| p.curved);
        let source_rel = source.as_ref().map(|(v, _)| relative(actual.volume, *v));
        let vol = exact.map(|e| relative(actual.volume, e.volume));
        let area = exact.map(|e| relative(actual.area, e.area));
        let bbox = exact.map(|e| bbox_deviation(&actual.bbox, &e.bbox));
        let label = format!("{model}:{}", shape.product_id);
        for (i, value) in [source_rel, vol, area, bbox].into_iter().enumerate() {
            if let Some(value) = value {
                self.maxima[i] = self.maxima[i].max(value);
            }
        }
        if actual.defects > 0 {
            self.violations
                .push(format!("{label}: {} closure defects", actual.defects));
        }
        if exact.is_none() {
            self.universe_mismatch
                .push(format!("{label}: retained published but exact has no mesh"));
        }
        if let Some(value) = source_rel {
            let key = if curved { "curved" } else { "linear" };
            if value
                > tolerances["sourceVolumeRelative"][key]
                    .as_f64()
                    .unwrap_or(0.)
            {
                self.violations
                    .push(format!("{label}: source volume deviation {value}"));
            }
        }
        if let Some((_, Some(bounds))) = source {
            let extent = (0..3).map(|i| bounds[i + 3] - bounds[i]).fold(0., f64::max);
            let limit = tolerances["sourceWorldBboxMetres"]["absolute"]
                .as_f64()
                .unwrap_or(0.)
                + extent
                    * tolerances["sourceWorldBboxMetres"]["extentFactor"]
                        .as_f64()
                        .unwrap_or(0.);
            let deviation = bbox_deviation(&actual.bbox, &bounds);
            if deviation > limit {
                self.violations
                    .push(format!("{label}: source bbox deviation {deviation}"));
            }
        }
        if !curved {
            for (value, key) in [
                (vol, "volumeRelative"),
                (area, "areaRelative"),
                (bbox, "bboxMetres"),
            ] {
                if value.is_some_and(|v| v > tolerances["exactLinear"][key].as_f64().unwrap_or(0.))
                {
                    self.violations
                        .push(format!("{label}: exact {key} deviation {value:?}"));
                }
            }
        }
        let format = |v: Option<f64>| v.map(|v| v.to_string()).unwrap_or_default();
        self.rows.push(format!(
            "{model}\t{}\t{}\tpublished\t\t\t{curved}\t{}\t{}\t{}\t{}\t{}\t{ms}\t{}\t{:?}",
            shape.product_id,
            shape.ifc_type.name(),
            format(source_rel),
            format(vol),
            format(area),
            format(bbox),
            actual.defects == 0,
            actual.volume,
            shape.obligations.0
        ));
        self.coverage
            .push(format!("{model}\t{}\tpublished\t", shape.product_id));
    }
    pub fn summary(&self) -> Value {
        json!({"schema":"ifc-lite.native-retained-comparison/1", "candidates":self.candidates,
            "published":self.published, "coveragePercent":if self.candidates == 0 { 0. } else { 100.*self.published as f64/self.candidates as f64 },
            "byCode":self.histogram, "maximumDeviations":{"sourceVolumeRelative":finite(self.maxima[0]),
                "exactVolumeRelative":finite(self.maxima[1]),"exactAreaRelative":finite(self.maxima[2]),"bboxMetres":finite(self.maxima[3])},
            "violations":self.violations,"universeMismatch":self.universe_mismatch,"skipped":self.skipped,
            "exact":{"milliseconds":self.exact_ms},"retained":{"milliseconds":self.retained_ms},"models":self.models})
    }
}
fn finite(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        json!("infinite")
    }
}

pub fn rss(children: bool) -> Result<i64, std::io::Error> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // getrusage initializes the entire output on success. Linux ru_maxrss is KiB.
    let result = unsafe {
        libc::getrusage(
            if children {
                libc::RUSAGE_CHILDREN
            } else {
                libc::RUSAGE_SELF
            },
            usage.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let usage = unsafe { usage.assume_init() };
    Ok(usage.ru_maxrss)
}
