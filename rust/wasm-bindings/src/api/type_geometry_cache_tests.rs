// SPDX-License-Identifier: MPL-2.0
use super::*;

// #7782: partial prepass columns must survive fallback discovery, and a new
// source after reset must not inherit either membership set from the old load.
#[test]
fn issue_7782_type_membership_fallback_preserves_installed_columns_and_resets() {
    let content = b"DATA;#20=IFCMAPPEDITEM(#10,$);#21=IFCMAPPEDITEM($,$);#30=IFCRELDEFINESBYTYPE($,$,$,$,(),#40);ENDSEC;";
    for installed_maps in [false, true] {
        for installed_types in [false, true] {
            let api = IfcAPI::new();
            if installed_maps { api.set_referenced_repmaps(&[99]); }
            if installed_types { api.set_instantiated_type_ids(&[88]); }
            let mut decoder = EntityDecoder::new(content);
            let (maps, types) = api.get_or_build_type_membership(content, &mut decoder);
            assert_eq!(*maps, [if installed_maps { 99 } else { 10 }].into_iter().collect());
            assert_eq!(*types, [if installed_types { 88 } else { 40 }].into_iter().collect());
            // A second lookup returns the same caches, without inspecting new bytes.
            let empty = b"DATA;ENDSEC;";
            let (warm_maps, warm_types) = api.get_or_build_type_membership(empty, &mut EntityDecoder::new(empty));
            assert!(Arc::ptr_eq(&maps, &warm_maps));
            assert!(Arc::ptr_eq(&types, &warm_types));
            assert!(api.mapped_instance_plan().is_none(), "fallback must not arm don't-bake instancing");
            api.clear_pre_pass_cache();
            let next = b"DATA;#50=IFCMAPPEDITEM(#60,$);#70=IFCRELDEFINESBYTYPE($,$,$,$,(),#80);ENDSEC;";
            let (next_maps, next_types) = api.get_or_build_type_membership(next, &mut EntityDecoder::new(next));
            assert_eq!(*next_maps, [60].into_iter().collect());
            assert_eq!(*next_types, [80].into_iter().collect());
        }
    }
}
