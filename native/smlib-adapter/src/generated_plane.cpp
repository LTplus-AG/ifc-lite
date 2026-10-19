// SPDX-License-Identifier: MPL-2.0
#include "generated_plane.hpp"
#include "representation_seal.hpp"
#include "context_metadata.hpp"
#include "copy.hpp"
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmFace.h>
#include <SmPlane.h>
#include <SmVertex.h>
#include <cstring>
#include <cmath>
namespace face_lineage {
namespace {
void require(bool ok,const char* message) { if(!ok) throw SweepFailure{IFCLITE_SMLIB_UNSUPPORTED,message}; }
void checked(SmStatus status) { if(status!=SM_SUCCESS) throw SweepFailure{IFCLITE_SMLIB_KERNEL_ERROR,"generated plane SDK construction failed"}; }
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
bool vector(const SmVector3d& a,const SmVector3d& b) { return bits(a.x,b.x) && bits(a.y,b.y) && bits(a.z,b.z); }
}
bool Ledger::creation_owner(SmObject* caller,SmObject* next,SmObject* old) noexcept {
    if(!creation.active || creation.frame!=frame_count || caller!=creation.surface) return false;
    if(creation.transitions>=creation.owner_limit || static_cast<SmSurface*>(caller)->GetOwner()!=old) { fail(Failure::InvalidEvent); return true; }
    auto* target=next?next:old;
    if(!target || !face(target)) { fail(Failure::InvalidEvent); return true; }
    auto* entry=binding(target,false); const auto* n=entry?node(entry->current):nullptr;
    if(!entry || !entry->alive || entry->retired || !entry->newborn || entry->birth_frame!=frame_count || !n || n->complete) {
        fail(Failure::UnknownHistory); return true;
    }
    if(!creation.face) {
        if(old || n->change!=Change::Construct) { fail(Failure::InvalidEvent); return true; }
        creation.face=static_cast<SmFace*>(target); creation.generation=entry->current;
    } else if(target!=creation.face || (next && old) ||
        (entry->current!=creation.generation && !(n->change==Change::Add && n->parent[0]==creation.generation))) {
        fail(Failure::InvalidEvent); return true;
    }
    ++creation.transitions; return true;
}
std::unique_ptr<SmBrep> GeneratedPlane::create(Ledger& ledger,const ObjectRevision& revision,
    const SmAxis2Placement& frame,const SmExtent2d& domain,SmFace*& output) {
    output=nullptr; ledger.check();
    require(!kernel_domain_is_tainted() && ledger.attached && !ledger.closed && ledger.frame_count &&
        ledger.frames[ledger.frame_count-1]->phase==Phase::InitialConstruction && !ledger.creation.object,
        "generated constructor requires one fresh private construction transaction");
    require(revision.incarnation && revision.session && revision.generation && revision.revision && revision.operation,
        "generated constructor requires an independently issued actual operation/object revision");
    require(std::isfinite(domain.GetUMin()) && std::isfinite(domain.GetUMax()) && std::isfinite(domain.GetVMin()) &&
        std::isfinite(domain.GetVMax()) && domain.GetUMin()<domain.GetUMax() && domain.GetVMin()<domain.GetVMax(),
        "invalid generated plane construction domain");
    auto& context=*ledger.context; raw_context::Restore restore(&context); std::unique_ptr<SmBrep> result;
    try {
        result=raw_context::construct_brep(&context); ledger.check(); ledger.verify_inventory(*result);
        ledger.creation.object=result.get(); ledger.creation.frame=ledger.frame_count; ledger.creation.revision=revision;
        ledger.creation.operation=ledger.append(Change::AuditBoundary); ledger.check();
        SmPlane* surface=nullptr; checked(SmPlane::CreateCanonical(context,frame,surface)); require(surface,"generated plane surface missing");
        ledger.check(); ledger.creation.surface=surface;
        checked(surface->AdjustSTEPUVDomain(domain)); ledger.check();
        ledger.creation.active=true;
        SmFace* face=nullptr; checked(result->CreateFaceFromSurface(surface,domain,face)); ledger.check();
        ledger.creation.active=false;
        require(face && ledger.creation.transitions>=3 && (ledger.creation.transitions&1),
            "generated plane completed constructor owner sequence");
        // SmFace::CreateUVTrimCurves uses exactly one detach/RAII-restore
        // pair (SmFace.cpp:8034,7936), still inside this fixed constructor.
        ledger.creation.transitions=0; ledger.creation.owner_limit=2;
        ledger.creation.active=true;
        // This is still the fixed initial constructor, never source healing.
        // CreateFaceFromSurface's default wrapper need not materialize trims.
        double ms=0,xs=0,me=0,xe=0,mv=0,xv=0;
        checked(face->CreateUVTrimCurves(FALSE,nullptr,nullptr,ms,xs,me,xe,mv,xv)); ledger.check();
        ledger.creation.active=false;
        require(face && face==ledger.creation.face && face->GetBrep()==result.get() && face->GetSurface()==surface &&
            surface->GetOwner()==face && result->GetNumFaces()==1 && result->GetNumEdges()==4 && result->GetNumVertices()==4,
            "generated plane constructor topology/ownership postcondition");
        const auto uv=face->GetUVDomain(); const auto& actual=surface->GetPosition(); const auto scale=surface->GetUVScale();
        require(vector(actual.GetOrigin(),frame.GetOrigin()) && vector(actual.GetXAxis(),frame.GetXAxis()) &&
            vector(actual.GetYAxis(),frame.GetYAxis()) && bits(scale.x,1.) && bits(scale.y,1.) &&
            bits(uv.GetUMin(),domain.GetUMin()) && bits(uv.GetUMax(),domain.GetUMax()) &&
            bits(uv.GetVMin(),domain.GetVMin()) && bits(uv.GetVMax(),domain.GetVMax()),"generated plane exact frame/domain postcondition");
        SmTArray<SmVertex*> vertices; result->GetVertices(vertices);
        require(vertices.GetSize()==4,"generated plane complete corner inventory");
        unsigned occupied=0;
        for(auto* vertex:vertices) {
            unsigned hits=0,corner=0,index=0;
            for(double u:{domain.GetUMin(),domain.GetUMax()}) for(double v:{domain.GetVMin(),domain.GetVMax()})
                { if(vector(vertex->GetPoint(),frame.GetOrigin()+u*frame.GetXAxis()+v*frame.GetYAxis())) { ++hits; corner=index; } ++index; }
            require(hits==1 && !(occupied&(1u<<corner)),"generated plane actual unique corner coefficient postcondition");
            occupied|=1u<<corner;
        }
        require(occupied==15 && ledger.creation.transitions==2,
            "generated plane completed exact constructor owner/corner sequence");
        require(context.GetUserNotifyCallback()==ledger.observer && !context.GetSysNotifyCallback() && !context.GetAttributeCallbacks(),
            "generated constructor callback authority changed");
        auto* entry=ledger.binding(face,false); require(entry && entry->initial_issuance,"generated plane constructor acquired unexpected edit history");
        ledger.creation.generation=entry->current;
        ledger.creation_seal.reset(new RepresentationSeal(ledger,*result,true)); ledger.check();
        output=face; return result;
    } catch(...) {
        ledger.creation.active=false; result.release();
        rethrow_tainted_kernel_domain("generated plane constructor");
    }
}
}
