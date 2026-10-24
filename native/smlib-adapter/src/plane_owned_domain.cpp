// SPDX-License-Identifier: MPL-2.0
#include "plane_owned_domain.hpp"
#include "plane_inventory.hpp"
#include "copy.hpp"
#include <SmCopyBrepMap.h>
#include <SmFace.h>
#include <unordered_map>
namespace {
using namespace plane_numeric;
void reconstruct(SmFace* face) {
    double mean_surface=0,max_surface=0,mean_vertex=0,max_vertex=0,mean_uv=0,max_uv=0;
    // Explicit SDK reconstruction only on the owned operand, without raising
    // any source/vertex/edge tolerances. Returned sampled gaps are diagnostics,
    // NEVER the enclosure proof. The full resulting inventory is read below.
    checked(face->CreateUVTrimCurves(FALSE,nullptr,nullptr,mean_surface,max_surface,
        mean_vertex,max_vertex,mean_uv,max_uv));
}
}
PreparedPlaneOperand::PreparedPlaneOperand(SmBrep* source):source_(source) {
    using namespace plane_numeric;
    const auto missing=preflight_plane_source(source);
    source_inventory_=plane_inventory(source,true);
    const auto core=plane_inventory(source,false);
    SmTArray<SmFace*> source_faces; source->GetFaces(source_faces);
    std::unordered_map<SmFace*,uint32_t> provenance;
    for(ULONG i=0;i<source_faces.GetSize();++i) provenance.emplace(source_faces[i],i);
    SmCopyBrepMap map;
    owned_=checked_brep_copy(source,nullptr,&map);
    try {
        // Compare actual coefficients AND mapped topology, not just counts.
        require(plane_inventory(owned_.get(),true,&map)==source_inventory_,
            "owned plane copy changed source inventory");
        verify_source();
        SmTArray<SmFace*> faces; owned_->GetFaces(faces);
        std::vector<bool> reconstructed;
        std::vector<uint32_t> source_indices;
        for(auto* face:faces) {
            auto* original=map.GetAt(face);
            const auto found=provenance.find(static_cast<SmFace*>(original));
            require(found!=provenance.end(),"owned plane face has no source provenance");
            source_indices.push_back(found->second);
            reconstructed.push_back(missing[found->second]);
            if(missing[found->second]) reconstruct(face);
        }
        // Validators may create other UV data. Finish ALL of them before
        // certification; no evaluator/validator runs on the operand afterward.
        validate_plane_solid(owned_.get(),"prepared host before domain certification");
        require(plane_inventory(owned_.get(),false,&map)==core,
            "owned trim reconstruction changed 3D source geometry");
        verify_source();
        domain_=certify_owned_plane_domain(owned_.get(),reconstructed);
        for(uint32_t i=0;i<domain_.cylinder_count;++i)
            domain_.cylinders[i].source_face=source_indices.at(domain_.cylinders[i].source_face);
        // Reporting is part of the proof contract, independently of bounding.
        bool any=false; for(bool value:reconstructed) any|=value;
        require(!any || (domain_.methods&8),"reconstructed domain lost method8 provenance");
        owned_inventory_=plane_inventory(owned_.get(),true);
    } catch(...) {
        owned_.release();
        rethrow_tainted_kernel_domain("owned plane domain preparation");
    }
}
PreparedPlaneOperand::~PreparedPlaneOperand() {
    if(kernel_domain_is_tainted()) owned_.release();
}
void PreparedPlaneOperand::verify_source() const {
    plane_numeric::require(plane_inventory(source_,true)==source_inventory_,
        "plane operation mutated source inventory");
}
void PreparedPlaneOperand::verify(SmBrep* expected) const {
    using namespace plane_numeric;
    require(!consumed_ && expected && expected==owned_.get(),"foreign or consumed owned plane domain");
    verify_source();
    require(plane_inventory(expected,true)==owned_inventory_,"owned plane inventory changed after certification");
}
std::unique_ptr<SmBrep> PreparedPlaneOperand::consume(SmBrep* expected) {
    verify(expected); consumed_=true; return std::move(owned_);
}
