// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" router helpers: eligibility of a mapped source for
//! instancing, while the common mapping program owns source recovery into the shared
//! registry. Every placeholder therefore uses the same reached child machine.

use super::GeometryRouter;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl GeometryRouter {
    /// #1623 Phase 2 eligibility: if this `MappedRepresentation` resolves to exactly
    /// ONE direct (non-mapped) geometry item, return that item's express id, else
    /// `None`. The don't-bake template↔instance model represents an occurrence with a
    /// SINGLE placeholder / a SINGLE re-tagged sub-mesh, so it only applies when the
    /// source is one solid. Multi-item sources (each carrying its own per-item
    /// colour/rep_identity) and nested-mapped sources fall through to the normal flat
    /// materialize — never instanced, never lost. The returned id is used as the
    /// placeholder's `geometry_id` so colour resolves EXACTLY as the flat/template
    /// sub-mesh does (both key on the nested solid's id).
    pub(crate) fn mapped_source_single_item(
        &self,
        mapped_repr: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<u32> {
        let items_attr = mapped_repr.get(3)?;
        let items = decoder.resolve_ref_list(items_attr).ok()?;
        match items.as_slice() {
            [only] if only.ifc_type != IfcType::IfcMappedItem => Some(only.id),
            _ => None,
        }
    }

}

#[cfg(test)]
pub(super) fn drive_placeholder(router:&mut GeometryRouter,decoder:&mut EntityDecoder<'_>,source_id:u32,item_id:u32)->crate::SubMeshCollection {
    router.enable_output_instancing(std::sync::Arc::new([(source_id,(2,item_id+1))].into_iter().collect()));
    let item=decoder.decode_by_id(item_id).expect("mapped occurrence");
    let mut output=crate::SubMeshCollection::new();
    router.collect_submeshes_from_item(&item,decoder,&mut output,true,None).expect("placeholder child machine");
    output
}
#[cfg(test)]
mod tests {
    use super::*;
    const BASE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
        #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);";
    fn wrap(fragment:&str,rep:u32,map:u32,item:u32)->String {
        format!("{BASE}{fragment}#{map}=IFCREPRESENTATIONMAP(#2,#{rep});#{item}=IFCMAPPEDITEM(#{map},#3);")
    }
    fn router()->GeometryRouter {
        let mut router=GeometryRouter::new();
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());router
    }
    #[test]
    fn both_drop_arms_of_actual_shared_source_children_are_recorded() {
        let mut router=router();
        for (child,map,item,ty) in [(7,100,200,"IfcExtrudedAreaSolid"),(8,101,202,"IfcGeometricSet")] {
            let source=wrap(&format!("#7=IFCEXTRUDEDAREASOLID($,$,$,0.);#8=IFCGEOMETRICSET(());
                #9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#{child}));"),9,map,item);
            let mut decoder=EntityDecoder::new(&source);
            let output=drive_placeholder(&mut router,&mut decoder,map,item);
            assert_eq!(output.len(),1);
            assert!(output.sub_meshes[0].mesh.positions.is_empty());
            assert_eq!(router.take_unsupported_items().get(ty),Some(&1));
        }
        assert_eq!(router.mapped_shared_unique_count(),0,"failed source children never publish geometry");
    }
    #[test]
    fn shared_source_drop_counting_uses_its_reached_representation_policy() {
        // A nonblank RepresentationType wins over RepresentationIdentifier,
        // including contradictory pairs. The same unsupported item is reached.
        for (identifier,rep_type,expected) in [("FootPrint","Annotation2D",0),
            ("Body","Annotation2D",0),("FootPrint","SweptSolid",1),("Body","SweptSolid",1)] {
            let source=wrap(&format!("#8=IFCANNOTATIONFILLAREA($,());
                #9=IFCSHAPEREPRESENTATION($,'{identifier}','{rep_type}',(#8));"),9,100,200);
            let mut decoder=EntityDecoder::new(&source);let mut router=router();
            let output=drive_placeholder(&mut router,&mut decoder,100,200);
            assert_eq!(output.len(),1);
            assert!(output.sub_meshes[0].mesh.positions.is_empty());
            assert!(router.cached_mapped_source(100).is_none(), "total-loss source cannot publish cached geometry");
            let dropped=router.take_unsupported_items();
            assert_eq!(dropped.values().sum::<u64>(),expected, "{identifier}/{rep_type}");
            if expected != 0 { assert_eq!(dropped.get("IfcAnnotationFillArea"),Some(&1)); }
            drive_placeholder(&mut router,&mut decoder,100,200);
            assert!(router.take_unsupported_items().is_empty(), "a repeated total-loss source is counted once");
        }
    }
    #[test]
    fn nested_source_materializes_full_geometry_instead_of_a_truncated_placeholder_cache() {
        let source=format!("{BASE}#11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
            #12=IFCREPRESENTATIONMAP(#2,#11);#13=IFCMAPPEDITEM(#12,#3);
            #20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#10,#13));
            #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#3);");
        let mut decoder=EntityDecoder::new(&source);let mut router=router();
        let materialized=drive_placeholder(&mut router,&mut decoder,21,22);
        assert_eq!(materialized.sub_meshes.iter().map(|sub|sub.mesh.indices.len()/3).sum::<usize>(),24);
        assert!(router.cached_mapped_source(21).is_none(),"multi-item source cannot publish a flat placeholder cache");
        let placeholder=drive_placeholder(&mut router,&mut decoder,12,13);
        assert_eq!(placeholder.len(),1);assert!(placeholder.sub_meshes[0].mesh.positions.is_empty());
        assert_eq!(router.cached_mapped_source(12).unwrap().indices.len()/3,12);
    }
    #[test]
    fn empty_source_does_not_poison_later_actual_placeholder_recovery() {
        let empty=wrap("#9=IFCSHAPEREPRESENTATION($,'Body','CSG',());",9,100,200);
        let mut router=router();let mut decoder=EntityDecoder::new(&empty);
        assert!(drive_placeholder(&mut router,&mut decoder,100,200).is_empty());
        assert!(router.cached_mapped_source(100).is_none());
        let repaired=wrap("#9=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));",9,100,200);
        let mut decoder=EntityDecoder::new(&repaired);
        let output=drive_placeholder(&mut router,&mut decoder,100,200);
        assert_eq!(output.len(),1);assert!(output.sub_meshes[0].mesh.positions.is_empty());
        assert_eq!(router.cached_mapped_source(100).unwrap().indices.len()/3,12);
    }
}
