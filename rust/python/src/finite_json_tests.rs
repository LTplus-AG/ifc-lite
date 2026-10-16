// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
struct Leaf {
    value: f64,
    maybe: Option<f32>,
}

#[derive(Serialize)]
struct Doc {
    scale: f64,
    rows: BTreeMap<u32, Vec<Leaf>>,
    pair: (f64, f64),
}

fn doc(scale: f64, value: f64, maybe: Option<f32>, pair: (f64, f64)) -> Doc {
    Doc { scale, rows: BTreeMap::from([(7, vec![Leaf { value: 1.0, maybe: None }, Leaf { value, maybe }])]), pair }
}

/// EDGE-FFI-5 (#7679): serde_json writes these as `null`; the probe refuses.
#[test]
fn json_that_would_carry_a_null_for_a_float_is_refused() {
    let control = doc(1.0, 2.0, Some(3.0), (4.0, 5.0));
    assert!(ensure_finite(&control).is_ok());
    assert_eq!(serde_json::to_string(&control).unwrap().matches("null").count(), 1, "only the None is null");

    let cases = [
        (doc(f64::NAN, 2.0, None, (0.0, 0.0)), "scale is non-finite (NaN)"),
        (doc(1.0, f64::INFINITY, None, (0.0, 0.0)), "rows.{}[1].value is non-finite (inf)"),
        (doc(1.0, 2.0, Some(f32::NEG_INFINITY), (0.0, 0.0)), "rows.{}[1].maybe is non-finite (-inf)"),
        (doc(1.0, 2.0, None, (0.0, f64::NAN)), "pair[1] is non-finite (NaN)"),
    ];
    for (bad, message) in cases {
        let err = ensure_finite(&bad).unwrap_err().to_string();
        assert!(err.starts_with(message), "{err}");
        assert!(serde_json::to_string(&bad).unwrap().contains("null"), "serde_json alone would hide it");
    }
}

#[test]
fn a_bare_float_reports_the_document() {
    assert!(ensure_finite(&f64::NAN).unwrap_err().to_string().starts_with("the document is non-finite"));
    assert!(ensure_finite(&vec![0.5f64, 1.5]).is_ok());
}
