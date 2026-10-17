/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::super::LandXmlMetadataRecord;

#[test]
fn wire_round_trip_and_unknown_name() {
    let record = LandXmlMetadataRecord::PlanWarning("w".to_owned());
    let bytes = record.serialize_value().unwrap();
    let value = serde_json::from_slice(&bytes).unwrap();
    let back = LandXmlMetadataRecord::from_wire(record.wire_name(), value).unwrap();
    assert!(matches!(back, LandXmlMetadataRecord::PlanWarning(w) if w == "w"));
    let err = LandXmlMetadataRecord::from_wire("nope", serde_json::Value::Null).unwrap_err();
    assert!(err.to_string().contains("unknown variant `nope`"), "{err}");
}
