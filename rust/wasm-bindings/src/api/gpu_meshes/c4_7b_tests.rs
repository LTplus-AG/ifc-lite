// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-7b (#8341): fallback full-file work is built once. The once pre-pass
//! installs the same columns the worker wire injects, and merge-layers
//! parts-to-skip reads the per-content material-layer index instead of
//! rebuilding its own.
use crate::api::IfcAPI;
use ifc_lite_core::EntityDecoder;

const PLAIN: &str = include_str!("../../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc");

/// The bare type map, now instanced (#61), mapped (#60) and layered (#75).
fn authored() -> String {
    PLAIN.replace("ENDSEC;\nEND-ISO", "\
#60=IFCMAPPEDITEM(#44,#45);
#61=IFCRELDEFINESBYTYPE('rel',$,$,$,(#1),#43);
#70=IFCMATERIAL('Layer',$,$);
#71=IFCMATERIALLAYER(#70,0.1,$);
#72=IFCMATERIALLAYER(#70,0.2,$);
#73=IFCMATERIALLAYERSET((#71,#72),'layers');
#74=IFCMATERIALLAYERSETUSAGE(#73,.AXIS2.,.POSITIVE.,0.);
#75=IFCRELASSOCIATESMATERIAL('material',$,$,$,(#43),#74);
ENDSEC;\nEND-ISO")
}

/// A wall aggregating two parts, every one with geometry, and NO material
/// association: only an injected index can make the wall sliceable.
const AGGREGATE: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001wall',$,'Parent',$,$,$,#51,$,$);
#101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#310=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101,#102));
ENDSEC;
END-ISO-10303-21;
";

fn sorted(set: &rustc_hash::FxHashSet<u32>) -> Vec<u32> {
    let mut ids: Vec<u32> = set.iter().copied().collect();
    ids.sort_unstable();
    ids
}

#[test]
fn c4_7b_parts_to_skip_reads_the_injected_layer_index_8341() {
    let source = AGGREGATE.as_bytes();
    // The worker wire's index says the wall is a sliceable two-layer buildup.
    let injected = IfcAPI::new();
    injected.set_merge_layers(true);
    injected.set_material_layer_index(&[100], &[2], &[2], &[1.0], &[0.0], &[7, 7], &[0.1, 0.2]);
    let mut decoder = EntityDecoder::new(source);
    let skip = injected.get_or_build_parts_to_skip(source, &mut decoder);
    assert_eq!(sorted(&skip), [101, 102], "parts of an injected sliceable parent are skipped");

    // The file itself authors no layer set: the lazy index is empty, so the
    // early return skips nothing.
    let lazy = IfcAPI::new();
    lazy.set_merge_layers(true);
    let mut decoder = EntityDecoder::new(source);
    assert!(lazy.get_or_build_parts_to_skip(source, &mut decoder).is_empty());
    assert!(lazy.get_or_build_material_layer_index(source, &mut decoder).is_empty());
}

#[test]
fn c4_7b_once_prepass_installs_the_columns_lazy_builds_would_scan_8341() {
    for source in [PLAIN.to_owned(), authored()] {
        let source = source.as_bytes();
        let once = IfcAPI::new();
        let data = once.build_prepass_once_data(source);
        let installed = |slot: &std::sync::Mutex<Option<std::sync::Arc<rustc_hash::FxHashSet<u32>>>>| {
            slot.lock().unwrap().as_ref().map(|set| sorted(set))
        };
        let referenced = installed(&once.content.cached_referenced_repmaps);
        let instantiated = installed(&once.content.cached_instantiated_type_ids);
        let layers = once.content.cached_material_layer_index.lock().unwrap().clone();

        // A fresh API with no pre-pass builds every column by its own walk.
        let lazy = IfcAPI::new();
        let mut decoder = EntityDecoder::new(source);
        let plan = lazy.get_or_build_type_geometry_plan(source, &mut decoder);
        assert_eq!(referenced, Some(sorted(&plan.referenced_representation_maps)));
        assert_eq!(instantiated, Some(sorted(&plan.instantiated_type_ids)));
        assert_eq!(layers.as_deref(), Some(&*lazy.get_or_build_material_layer_index(source, &mut decoder)));

        // Same type jobs as before: the orphan boiler type until #60 maps it.
        let type_jobs: Vec<u32> = data.complex_jobs.iter().map(|job| job.0).filter(|&id| id == 43).collect();
        let mapped = referenced.as_deref() == Some(&[44]);
        assert_eq!(type_jobs, if mapped { vec![] } else { vec![43] });
        assert_eq!(mapped, instantiated.as_deref() == Some(&[43]));
        assert_eq!(mapped, layers.is_some_and(|index| index.is_sliceable(43)));
    }
}
