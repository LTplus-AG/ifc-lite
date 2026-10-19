// SPDX-License-Identifier: MPL-2.0
#include "representation_seal.hpp"
#include "context_metadata.hpp"
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmSurface.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmFaceuse.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <SmOwningTopology.h>
#include <SmRegion.h>
#include <SmShell.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
#include <cstring>
#include <new>
namespace face_lineage {
namespace {
constexpr size_t words=1048576,objects=8192;
void require(bool ok,const char* message) { if(!ok) throw SweepFailure{IFCLITE_SMLIB_UNSUPPORTED,message}; }
}
void RepresentationSeal::word(uint64_t value) {
    if(scratch.size()==words) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"exact representation seal word budget"};
    scratch.push_back(value);
}
void RepresentationSeal::real(double value) { uint64_t bits; static_assert(sizeof(bits)==sizeof(value)); std::memcpy(&bits,&value,sizeof(bits)); word(bits); }
void RepresentationSeal::pointer(const void* value) { word(reinterpret_cast<uintptr_t>(value)); }
void RepresentationSeal::object(SmObject* value) {
    if(!value) return;
    for(auto* existing:pending) {
        if(++work>1048576) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"exact representation seal walk budget"};
        if(existing==value) return;
    }
    if(pending.size()==objects) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"exact representation seal object budget"};
    pending.push_back(value);
}
RepresentationSeal::RepresentationSeal(Ledger& value,SmBrep& solid):RepresentationSeal(value,solid,false) {}
RepresentationSeal::RepresentationSeal(Ledger& value,SmBrep& solid,bool creation):ledger(value),source(solid),initial(creation) {
    try {
        ledger.check(); operation=ledger.append(Change::AuditBoundary); ledger.check();
        retained.reserve(words); scratch.reserve(words); pending.reserve(objects);
        capture(); retained.swap(scratch);
    } catch(const std::bad_alloc&) { throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"bounded exact representation seal allocation"}; }
}
void RepresentationSeal::capture() {
    if(!initial) ledger.verify_inventory(source);
    else {
        ledger.check();
        require(ledger.creation.object==&source && ledger.creation.face && ledger.creation.frame==ledger.frame_count &&
            !ledger.creation.active && source.GetNumFaces()==1,"expired or foreign generated construction receipt");
        SmTArray<SmFace*> actual; source.GetFaces(actual);
        require(actual.GetSize()==1 && actual[0]==ledger.creation.face && actual[0]->GetBrep()==&source,
            "generated construction receipt requires its exact live face inventory");
        auto* binding=ledger.binding(ledger.creation.face,false);
        require(binding && binding->alive && !binding->retired && !binding->removed && binding->newborn && binding->initial_issuance &&
            binding->current==ledger.creation.generation,"generated constructor history changed before issuance");
    }
    scratch.clear(); pending.clear(); work=0;
#ifdef SM_USE_NEWTOL
    require(false,"new tolerance-model semantics need a separate exact seal audit");
#endif
    require(source.GetNumFaces()>0,"faceless sealed phases need separately issued object revision authority");
    require(source.GetNumFaces()<=objects && source.GetNumEdges()<=objects && source.GetNumVertices()<=objects &&
        source.GetSize()<=objects,"owned graph exceeds exact seal topology budget");
    auto& context=*const_cast<SmContext*>(source.GetContext());
    require(!context.GetAttributeCallbacks() && !context.GetSysNotifyCallback(),"foreign attribute/system callbacks cannot authorize sealed numerical phases");
    pointer(&source); pointer(&context);
    word(operation.domain); word(operation.sequence);
    if(initial) {
        word(ledger.creation.operation.domain); word(ledger.creation.operation.sequence);
        const auto& r=ledger.creation.revision;
        word(r.incarnation); word(r.session); word(r.slot); word(r.generation); word(r.revision); word(r.operation);
    }
    for(auto metadata:{raw_context::Access<SmBrep>::get(source),raw_context::Access<SmContext>::get(context)}) {
        real(metadata.size); real(metadata.ratio); real(metadata.zone);
    }
    // Raw DEFAULT sentinels plus their current effective global policies.
    real(SmTol::GetModelSizeEstimate()); real(SmTol::GetLargeSmallSizeRatio());
    real(SmTol::GetZoneTol3d(&context)); real(source.GetTolerance());
    word(context.GetDoingBoolean()); word(source.m_bEditingEnabled); word(source.m_bValidateOnly);
    pointer(source.GetInfiniteRegion()); pointer(source.GetList()); word(source.GetSize());
    require(!source.HasAttributes(),"attributed SDK graphs need an audited attribute numerical contract");
    SmTArray<SmTopology*> topology; source.GetTopology(topology);
    require(topology.GetSize()<=objects,"unsupported topology seal size");
    word(topology.GetSize());
    for(auto* item:topology) { pointer(item); object(item); }
    for(size_t i=0;i<pending.size();++i) {
        auto* item=pending[i]; const auto type=item->GetType(); pointer(item); word(type); pointer(item->GetContext());
        require(item->GetContext()==&context,"cross-context dependencies are unavailable for exact sealed phases");
        if(item->IsKindOf(SmCurve_TYPE)) { curve(item); continue; }
        if(item->IsKindOf(SmSurface_TYPE)) { surface(item); continue; }
        require(item->IsKindOf(SmTopology_TYPE),"unknown object in numerical seal");
        auto* t=static_cast<SmTopology*>(item);
        require(t->GetBrep()==&source,"foreign topology dependency in exact seal");
        require(!t->HasAttributes(),"attributed topology is unavailable for sealed numerical phases");
        pointer(t->GetOwner()); pointer(t->GetNext()); pointer(t->GetLast()); word(t->GetAllFlags());
        if(auto* owning=dynamic_cast<SmOwningTopology*>(t)) {
            pointer(owning->GetList()); word(owning->GetSize());
            require(owning->GetSize()<=objects,"unsupported owned topology seal size");
            auto* child=owning->GetList();
            for(ULONG j=0;j<owning->GetSize();++j) {
                require(child && (!j || child!=owning->GetList()),"incomplete owned topology inventory");
                object(child); child=child->GetNext();
            }
            require(!owning->GetSize() || child==owning->GetList(),"noncircular owned topology inventory");
        }
        switch(type) {
            case SmRegion_TYPE: word(static_cast<SmRegion*>(t)->IsVoid()); break;
            case SmShell_TYPE: pointer(static_cast<SmShell*>(t)->GetRegion()); break;
            case SmFace_TYPE: {
                auto* f=static_cast<SmFace*>(t); auto uv=f->GetUVDomain();
                real(f->GetTolerance()); word(f->GetRectangularTrim());
                real(uv.GetUMin()); real(uv.GetUMax()); real(uv.GetVMin()); real(uv.GetVMax());
                auto id=initial?ledger.binding(f,false)->current:ledger.identity(f); word(id.domain); word(id.sequence);
                std::array<Root,1024> roots{}; const auto count=initial?0:ledger.roots(id,roots.data(),roots.size()); word(count);
                for(uint32_t r=0;r<count;++r) {
                    const auto& root=roots[r]; word(root.identity.domain); word(root.identity.sequence); word(uint64_t(root.kind));
                    word(root.object.incarnation); word(root.object.session); word(root.object.slot); word(root.object.generation);
                    word(root.object.revision); word(root.object.operation);
                }
                pointer(f->GetUpwardFaceuse()); pointer(f->GetSurface()); object(f->GetSurface()); break;
            }
            case SmFaceuse_TYPE: {
                auto* f=static_cast<SmFaceuse*>(t); pointer(f->GetFace()); pointer(f->GetMate()); word(f->GetOrientation()); break;
            }
            case SmLoop_TYPE: pointer(static_cast<SmLoop*>(t)->GetLoopuse()); break;
            case SmLoopuse_TYPE: {
                auto* l=static_cast<SmLoopuse*>(t); pointer(l->GetLoop()); object(l->GetLoop()); pointer(l->GetOtherLoopuse());
                pointer(l->GetEUorVU()); word(l->GetLoopuseType()); word(l->GetOrientation()); break;
            }
            case SmEdge_TYPE: {
                auto* e=static_cast<SmEdge*>(t); const auto interval=e->GetInterval();
                real(e->GetTolerance()); real(interval.GetMin()); real(interval.GetMax());
                pointer(e->GetCurve()); object(e->GetCurve()); require(e->GetCurve(),"missing edge geometry in seal"); break;
            }
            case SmEdgeuse_TYPE: {
                auto* e=static_cast<SmEdgeuse*>(t); word(e->GetEdgeuseType()); word(e->GetOrientation());
                pointer(e->GetMate()); pointer(e->GetRadial()); pointer(e->GetVertexuse()); pointer(e->GetFaceuse());
                pointer(e->GetLoopuse()); pointer(e->GetCWEdgeuse()); pointer(e->GetCCWEdgeuse());
                require(e->IsLoopEdgeuse() && !e->GetDropCurveFail(),"wire or failed trim state requires a separate seal contract");
                auto* trim=e->GetUVTrimCurvePointer(); pointer(trim); object(trim);
                require(e->GetUVTrimCurve(),"missing actual UV trim in seal"); break;
            }
            case SmVertex_TYPE: {
                auto* v=static_cast<SmVertex*>(t); const auto p=v->GetPoint();
                real(v->GetTolerance()); real(p.x); real(p.y); real(p.z); break;
            }
            case SmVertexuse_TYPE: {
                auto* v=static_cast<SmVertexuse*>(t); const auto uv=v->GetUVPoint(); word(v->GetVertexuseType());
                pointer(v->GetEdgeuse()); pointer(v->GetLoopuse()); pointer(v->GetFaceuse()); real(uv.x); real(uv.y); break;
            }
            default: require(false,"specialized topology is unavailable for exact sealed phases");
        }
    }
    for(auto* item:pending) {
        SmObject* owner=nullptr;
        if(item->IsKindOf(SmCurve_TYPE)) owner=static_cast<SmCurve*>(item)->GetOwner();
        else if(item->IsKindOf(SmSurface_TYPE)) owner=static_cast<SmSurface*>(item)->GetOwner();
        else continue;
        bool included=false; for(auto* candidate:pending) {
            if(++work>1048576) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"exact representation seal owner budget"};
            if(candidate==owner) { included=true; break; }
        }
        require(included,"unowned or external supporting geometry is unavailable for exact seal");
    }
    word(pending.size()); ledger.check();
}
void RepresentationSeal::verify() {
    try { capture(); }
    catch(...) { ledger.fail(Failure::RepresentationChanged); throw; }
    if(retained!=scratch) {
        ledger.fail(Failure::RepresentationChanged); ledger.check();
    }
}
}
