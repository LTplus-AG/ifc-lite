// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The data-model tests that need the server's Parquet writer. The extractor
//! tests moved with the extractors, to `ifc_lite_processing::data_model`.

use super::{extract_data_model, DataModelEntities};
use crate::services::serialize_data_model_to_parquet;

/// #7675 SERVER-26: a table over its budget is not served truncated, the
/// refusal travels to the serializer (the extraction half of this test is
/// `server_26_material_rows_are_budgeted_not_elements_times_layers` in
/// `ifc_lite_processing::data_model`).
#[test]
fn server_26_a_refused_material_table_is_not_serialised() {
    let layers = vec!["#3"; 1_000].join(",");
    let elements: Vec<String> = (0..1_000).map(|i| format!("#{}", 100 + i)).collect();
    let ifc = format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCMATERIAL('Concrete',$,$);\n\
         #3=IFCMATERIALLAYER(#2,0.1,$,'Core',$,$,$);\n\
         #4=IFCMATERIALLAYERSET(({layers}),'Wall',$);\n\
         #5=IFCRELASSOCIATESMATERIAL('Rel0000000000000007675',$,$,$,({}),#4);\n\
         ENDSEC;\nEND-ISO-10303-21;\n",
        elements.join(",")
    );
    let dm = extract_data_model(&ifc);
    let refused = serialize_data_model_to_parquet(&dm).expect_err("a truncated table was served");
    assert!(refused.to_string().contains("material"), "{refused}");
}

/// The budget binds hostile products, not real buildups: a few walls with a
/// three-layer set serialise.
#[test]
fn server_26_ordinary_layer_sets_serialise() {
    let ifc = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
        #2=IFCMATERIAL('Concrete',$,$);\n\
        #3=IFCMATERIALLAYER(#2,0.1,$,'Core',$,$,$);\n\
        #4=IFCMATERIALLAYERSET((#3,#3,#3),'Wall',$);\n\
        #5=IFCRELASSOCIATESMATERIAL('Rel0000000000000007675',$,$,$,(#10,#11,#12,#13),#4);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let dm = extract_data_model(ifc);
    serialize_data_model_to_parquet(&dm).expect("served");
}

/// Manual cross-runtime oracle: write the Parquet payload of a real IFC for the
/// TS decoder/viewer to check. Reads `IFCLITE_MATERIAL_PARQUET_IN`, writes
/// `IFCLITE_MATERIAL_PARQUET_OUT`; does nothing unless both are set. (The
/// duplex and merged-exporter assertions run in `ifc_lite_processing`.)
#[test]
fn manual_material_parquet_oracle() {
    let (Ok(input), Ok(output)) = (
        std::env::var("IFCLITE_MATERIAL_PARQUET_IN"),
        std::env::var("IFCLITE_MATERIAL_PARQUET_OUT"),
    ) else {
        return;
    };
    let source = std::fs::read(input).expect("read oracle input");
    let payload = serialize_data_model_to_parquet(&extract_data_model(&source)).expect("serialize data model");
    std::fs::write(output, payload).expect("write oracle Parquet payload");
}

/// The wire names and the default. `all` is the default so a request that
/// predates #6034 deserializes to exactly the old behaviour.
#[test]
fn issue_6034_query_values() {
    #[derive(serde::Deserialize)]
    struct Q {
        #[serde(default)]
        data_model_entities: DataModelEntities,
    }
    let parse = |s: &str| {
        let uri: axum::http::Uri = format!("/x?{s}").parse().unwrap();
        axum::extract::Query::<Q>::try_from_uri(&uri).map(|q| q.0.data_model_entities)
    };
    assert_eq!(parse("").unwrap(), DataModelEntities::All);
    assert_eq!(parse("data_model_entities=all").unwrap(), DataModelEntities::All);
    assert_eq!(parse("data_model_entities=rooted").unwrap(), DataModelEntities::Rooted);
    assert!(parse("data_model_entities=objects").is_err(), "an unknown value is refused, not defaulted");
}
