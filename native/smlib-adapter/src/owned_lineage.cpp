// SPDX-License-Identifier: MPL-2.0
#include "owned_lineage.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include "representation_seal.hpp"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmFace.h>
#include <atomic>
#include <cmath>
namespace face_lineage {
namespace {
void require(bool ok,const char* why) {
    if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why};
}
std::atomic<uint64_t> next_revision{1};
uint64_t revision() {
    auto value=next_revision.load();
    do { require(value!=UINT64_MAX,"native object revision exhausted"); }
    while(!next_revision.compare_exchange_weak(value,value+1));
    return value;
}
}
OwnedBoundary::State::State(SmContext& context):ledger(),observation(ledger,context) {}
void OwnedBoundary::require_live() const {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"native lineage owner refused after taint"};
    if(!state || !solid) throw AdapterFailure{IFCLITE_SMLIB_INVALID_ARGUMENT,"moved-from native lineage owner"};
}
OwnedBoundary::OwnedBoundary(std::shared_ptr<State> value,std::unique_ptr<SmBrep> body):
    state(std::move(value)),solid(std::move(body)) {}
OwnedBoundary::OwnedBoundary(OwnedBoundary&&) noexcept=default;
OwnedBoundary::~OwnedBoundary() {
    if(kernel_domain_is_tainted()) solid.release();
    // Member order destroys the actual SDK object BEFORE its continuous owner.
}
OwnedBoundary OwnedBoundary::box(double width,double depth,double height) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"native lineage owner refused after taint"};
    require(std::isfinite(width) && width>0 && std::isfinite(depth) && depth>0 &&
        std::isfinite(height) && height>0,"invalid native box dimensions");
    auto& context=*SmApiGetOrCreateContext();
    require(!context.GetUserNotifyCallback() && !context.GetSysNotifyCallback() &&
        !context.GetAttributeCallbacks(),"native construction requires exclusive callback ownership");
    const auto issued=revision();
    std::unique_ptr<SmBrep> body;
    try {
    SmBrep* raw=nullptr;
    // Fixed bootstrap only: the constructor has no prior ancestry. No arbitrary
    // existing BRep can be adopted; no caller hook can mutate this interval.
    const auto status=SmApiCreateBox(SmVector3d(0,0,0),width,depth,height,raw);
    body.reset(raw);
    require(status==SM_SUCCESS && body,"native box constructor failed");
    auto owner=std::make_shared<State>(context);
    SmTArray<SmFace*> actual; body->GetFaces(actual);
    require(actual.GetSize()==6,"native box constructor boundary inventory");
    std::vector<Seed> seeds;
    for(auto* face:actual) seeds.push_back({face,RootKind::SourceBoundary});
    owner->ledger.admit_roots(*body,ObjectRevision{1,1,0,1,issued,0},seeds.data(),seeds.size());
    return OwnedBoundary(std::move(owner),std::move(body));
    } catch(...) { body.release(); rethrow_tainted_kernel_domain("native lineage constructor"); }
}
OwnedBoundary OwnedBoundary::copy() const {
    require_live();
    auto copied=checked_brep_copy(solid.get(),&state->ledger);
    return OwnedBoundary(state,std::move(copied));
}
std::vector<Identity> OwnedBoundary::faces() const {
    require_live();
    state->ledger.verify_inventory(*solid);
    SmTArray<SmFace*> actual; solid->GetFaces(actual);
    std::vector<Identity> result; result.reserve(actual.GetSize());
    for(auto* face:actual) result.push_back(state->ledger.identity(face));
    return result;
}
std::vector<Root> OwnedBoundary::ancestors(Identity id) const {
    require_live();
    std::vector<Root> result(1024);
    result.resize(state->ledger.roots(id,result.data(),result.size()));
    return result;
}
std::unique_ptr<AdapterMesh> OwnedBoundary::tessellate(double chord,double angle) const {
    require_live();
    require(std::isfinite(chord) && chord>0 && std::isfinite(angle) && angle>0 && angle<=180,
        "invalid native tessellation tolerances");
    Scope phase(state->ledger,*const_cast<SmContext*>(solid->GetContext()),solid.get());
    RepresentationSeal seal(state->ledger,*solid);
    try {
        auto result=tessellate_mesh(solid.get(),chord,angle,&state->ledger);
        state->ledger.check(); seal.verify(); state->ledger.verify_inventory(*solid);
        phase.finish(); state->ledger.check();
        result->provenance.owner=state;
        return result;
    } catch(...) { rethrow_tainted_kernel_domain("owned lineage tessellation"); }
}
OwnedBoundary OwnedBoundary::affine(const double*) const {
    require_live();
    throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"native lineage affine numerical transition is unaudited"};
}
OwnedBoundary OwnedBoundary::boolean(const OwnedBoundary&,uint32_t) const {
    require_live();
    throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"native lineage Boolean classification/history is unaudited"};
}
OwnedBoundary OwnedBoundary::clip(const double*,int32_t,uint32_t) const {
    require_live();
    throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"native lineage clip/generated-interface ancestry is unaudited"};
}
}
