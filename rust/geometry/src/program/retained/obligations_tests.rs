// SPDX-License-Identifier: MPL-2.0
//! #7955 R1: a construction plan does not certify relationship closure.
use super::*;

#[test]
fn relationship_host_keeps_all_unchecked_obligations() {
    let relationships = "
#80=IFCOPENINGELEMENT('o',$,'Opening',$,$,#9,#21,$,.OPENING.);
#81=IFCRELVOIDSELEMENT('v',$,$,$,#10,#80);
#82=IFCMATERIAL('Layer material',$,$);
#83=IFCMATERIALLAYER(#82,0.2,$,$,$,$,$);
#84=IFCMATERIALLAYERSET((#83),'Layers',$);
#85=IFCMATERIALLAYERSETUSAGE(#84,.AXIS2.,.POSITIVE.,0.,$);
#86=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#10),#85);
ENDSEC;END-ISO-10303-21;";
    // The same conservative contract applies before relationship discovery,
    // including a product whose source actually carries both obligations.
    for bytes in [
        SOURCE.to_owned(),
        SOURCE.replace("ENDSEC;END-ISO-10303-21;", relationships),
    ] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
        let plan = program.finish().unwrap();
        assert_eq!(plan.values.len(), 1);
        assert!(plan.values[0].is_product_placed());
        assert_eq!(
            plan.remaining,
            vec![
                RetainedRequirement::OpeningClosure,
                RetainedRequirement::MaterialLayers,
                RetainedRequirement::IfcAppearance,
                RetainedRequirement::PersistentFaces,
            ]
        );
    }
}
