// SPDX-License-Identifier: MPL-2.0
//! ROUTER-37 (#8385 X3): an opening that yields no cutter, because its id does
//! not decode or its own body fails or meshes empty, used to leave no trace.
//! It is now one dropped item in the router's unsupported-item map, counted
//! once per opening per router and never by the quiet residual pass.
use super::classify;
use crate::processors::BlockProcessor;
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

/// A block-bodied wall (#1), a block-bodied opening (#20, #21), and an
/// opening with no representation at all (#22).
const SOURCE: &str = "#10=IFCBLOCK($,2.,3.,4.);
#1=IFCWALL('host',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#20=IFCOPENINGELEMENT('opening',$,$,$,$,$,#2,$);
#21=IFCOPENINGELEMENT('second',$,$,$,$,$,#2,$);
#22=IFCOPENINGELEMENT('no-body',$,$,$,$,$,$,$);";

/// The real block processor, or an ordinary (non-stop) refusal of every block.
struct Block {
    fail: bool,
}
impl GeometryProcessor for Block {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        if self.fail {
            return Err(Error::geometry("opening body refused"));
        }
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}

fn router(fail: bool) -> GeometryRouter {
    let mut router = GeometryRouter::new();
    router.register(Box::new(Block { fail }));
    router
}

fn unsupported(router: &GeometryRouter) -> Vec<(String, u64)> {
    let mut items: Vec<_> = router.take_unsupported_items().into_iter().collect();
    items.sort();
    items
}

fn classified(router: &GeometryRouter) -> usize {
    let counts = router.take_classification_stats();
    counts.rectangular + counts.diagonal + counts.non_rectangular
}

#[test]
fn router_37_an_undecodable_opening_id_is_recorded_once_per_router() {
    let router = router(false);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    assert!(classify(&host, &[999, 999], true, &router, &mut decoder).unwrap().is_empty());
    assert!(classify(&host, &[999], true, &router, &mut decoder).unwrap().is_empty());
    // An id that never decoded has no type of its own: it is keyed by the
    // declared type of IfcRelVoidsElement.RelatedOpeningElement.
    assert_eq!(unsupported(&router), [("IfcFeatureElementSubtraction".to_string(), 1)]);
    assert!(classify(&host, &[998], false, &router, &mut decoder).unwrap().is_empty());
    assert!(unsupported(&router).is_empty(), "the quiet residual pass records nothing");
    assert_eq!(classified(&router), 0, "an unmeshable opening is not a classification");
    assert!(router.take_host_opening_diagnostics().is_empty(), "no empty host bucket");
}

#[test]
fn router_37_an_empty_opening_body_is_recorded_once_per_router() {
    let router = router(false);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    let cut = classify(&host, &[22, 20, 22], true, &router, &mut decoder).unwrap();
    assert_eq!(cut.len(), 1, "the meshable sibling is still a cutter");
    assert_eq!(classified(&router), 1);
    assert_eq!(unsupported(&router), [("IfcOpeningElement".to_string(), 1)]);
    assert!(classify(&host, &[22], false, &router, &mut decoder).unwrap().is_empty());
    assert!(unsupported(&router).is_empty(), "the quiet residual pass records nothing");
}

#[test]
fn router_37_a_failed_opening_body_is_recorded_once_per_opening() {
    let router = router(true);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    assert!(classify(&host, &[20, 21], true, &router, &mut decoder).unwrap().is_empty());
    assert!(classify(&host, &[20], true, &router, &mut decoder).unwrap().is_empty());
    let items = router.take_unsupported_items();
    assert_eq!(items.get("IfcOpeningElement"), Some(&2), "openings 20 and 21, once each: {items:?}");
    assert_eq!(classified(&router), 0);
}

/// A tessellation-quality change re-walks every host, so the opening counts
/// again, exactly as a dropped `IfcRepresentationMap` source does.
#[test]
fn router_37_a_quality_change_forgets_recorded_openings() {
    let mut router = router(false);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    assert!(classify(&host, &[22], true, &router, &mut decoder).unwrap().is_empty());
    assert_eq!(unsupported(&router).len(), 1);
    router.set_tessellation_quality(TessellationQuality::Low);
    assert!(classify(&host, &[22], true, &router, &mut decoder).unwrap().is_empty());
    assert_eq!(unsupported(&router), [("IfcOpeningElement".to_string(), 1)]);
}
