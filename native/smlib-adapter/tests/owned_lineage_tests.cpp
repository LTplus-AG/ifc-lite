// SPDX-License-Identifier: MPL-2.0
// #7955: actual SDK owner/copy/tessellation; unbound IFC and unaudited ops refuse.
#include "owned_lineage.hpp"
#include "owned_lineage_geometry.hpp"
#include "failure.hpp"
#include <algorithm>
#include <stdexcept>
namespace {
using namespace face_lineage;
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
template<class F> void refused(F action) {
    bool rejected=false;
    try { action(); } catch(const AdapterFailure& e) { rejected=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
    require(rejected,"unaudited operation must refuse before lineage publication");
}
}
void owned_copy_tessellation() {
    // This native root names the exact constructor invocation, not an IFC face.
    auto source=OwnedBoundary::box(2,3,4);
    const auto before=source.faces(); require(before.size()==6,"owned constructor has six native roots");
    const auto source_geometry=owned_geometry::source_faces(source);
    auto copy=source.copy();
    const auto copied=copy.faces(); require(copied.size()==6,"owned copy boundary inventory");
    std::vector<Identity> seen;
    for(auto id:copied) {
        const auto roots=copy.ancestors(id);
        require(roots.size()==1 && roots[0].kind==RootKind::SourceBoundary,
            "copy preserves exact native constructor ancestor");
        require(std::find(before.begin(),before.end(),roots[0].identity)!=before.end(),
            "copy root comes from the actual source object");
        require(std::find(seen.begin(),seen.end(),roots[0].identity)==seen.end(),
            "copy map preserves all six distinct source faces");
        seen.push_back(roots[0].identity);
    }
    for(double chord:{0.01,0.005}) {
        auto mesh=copy.tessellate(chord,15);
        require(mesh->provenance.evidence==Evidence::NativeOnly && mesh->provenance.owner &&
            !mesh->provenance.authenticated_ifc_source(),"native correspondence never authenticates IFC source");
        require(mesh->provenance.triangles.size()==mesh->indices.size()/3 &&
            mesh->normals.size()==mesh->indices.size()*3,"native triangle identity preserves reviewed corner normals");
        std::vector<Identity> covered;
        for(auto id:mesh->provenance.triangles) {
            require(std::find(copied.begin(),copied.end(),id)!=copied.end(),
                "actual GetOriginalFace binds each triangle to a live event identity");
            if(std::find(covered.begin(),covered.end(),id)==covered.end()) covered.push_back(id);
        }
        require(covered.size()==6 && copy.faces()==copied,"retessellation preserves all native face identities");
        for(size_t triangle=0;triangle<mesh->provenance.triangles.size();++triangle)
            owned_geometry::check_triangle(*mesh,triangle,copy,source_geometry);
    }
    const double affine[16]={2,0,0,0,0,3,0,0,0,0,4,0,0,0,0,1};
    const double plane[6]={1,0,0,1,0,0};
    refused([&] { auto unavailable=copy.affine(affine); });
    refused([&] { auto unavailable=copy.boolean(source,IFCLITE_SMLIB_UNION); });
    refused([&] { auto unavailable=copy.clip(plane,1,IFCLITE_SMLIB_INTERSECTION); });
    require(source.faces()==before && copy.faces()==copied,"refused operations preserve both owned inputs");
}

void run_owned_lineage_tests() {
    owned_copy_tessellation(); // observer is destroyed before the legacy ABI lane
    uint64_t session=0; ifclite_smlib_handle source{},moved{},combined{},clipped{},mesh{};
    auto ok=[](int32_t status) { require(status==IFCLITE_SMLIB_OK,"actual ABI provenance fixture succeeded"); };
    ok(ifclite_smlib_session_create(&session));
    ok(ifclite_smlib_box(session,0,0,0,2,2,2,&source));
    require(unavailable_reason(session,source)==UnknownReason::UnobservedConstruction,
        "legacy constructor cannot acquire certified native history after the fact");
    const double matrix[16]={1,0,0,0,0,1,0,0,0,0,1,0,1,0,0,1};
    ifclite_smlib_affine_certificate affine{};
    ok(ifclite_smlib_copy_affine(session,source,matrix,&moved,&affine));
    require(unavailable_reason(session,moved)==UnknownReason::UnauditedAffine,
        "legacy affine has explicit unavailable lineage");
    ok(ifclite_smlib_boolean(session,source,moved,IFCLITE_SMLIB_UNION,&combined));
    require(unavailable_reason(session,combined)==UnknownReason::UnauditedBoolean,
        "legacy Boolean is never relabelled as constructor ancestry");
    const double plane[6]={1,0,0,1,0,0}; ifclite_smlib_plane_certificate certificate{};
    ok(ifclite_smlib_clip_plane(session,source,plane,1,IFCLITE_SMLIB_INTERSECTION,&clipped,&certificate));
    require(unavailable_reason(session,clipped)==UnknownReason::UnauditedClip,
        "legacy clip has no authenticated generated interface ancestry");
    ok(ifclite_smlib_tessellate(session,source,0.01,15,&mesh));
    require(unavailable_reason(session,mesh)==UnknownReason::UnobservedTessellation,
        "revision-local face indices are not persistent provenance");
    ok(ifclite_smlib_session_destroy(session));
}
