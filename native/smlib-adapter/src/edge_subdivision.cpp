// SPDX-License-Identifier: MPL-2.0
#include "edge_subdivision.hpp"
#include "context_metadata.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
namespace face_lineage {
void EdgeSubdivision::require(bool ok,const char* why) {
    if(!ok) {
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
        if(ledger.failed()==Failure::None) std::fprintf(stderr,
            "subdivision refusal stage=%u step=%u split=%u cut=%.17g reason=%s\n",
            unsigned(stage),step,count,cut,why);
#endif
        ledger.fail(Failure::UnsupportedGeometryChange); throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why};
    }
}
EdgeSubdivision::EdgeSubdivision(Ledger& value,SmBrep& source):ledger(value),geometry(value,source,this) {
    operation=ledger.numerical.operation; frame=ledger.numerical.frame; serial=ledger.numerical.serial;
    raw_context::Access<SmContext>::set(scratch_context,raw_context::Access<SmContext>::get(*source.GetContext()));
    require(!scratch_context.GetUserNotifyCallback() && !scratch_context.GetSysNotifyCallback() &&
        !scratch_context.GetAttributeCallbacks(),"subdivision verifier requires an isolated scratch context");
    faces.reserve(16); uses.reserve(16);
}
EdgeSubdivision::~EdgeSubdivision()=default;
void EdgeSubdivision::live(SmObject* object,Identity id) {
    const auto* entry=ledger.binding(object,false);
    require(entry && entry->alive && !entry->retired && entry->current==id && id.sequence,
        "subdivision receipt generation expired");
}
EdgeSubdivision::Live EdgeSubdivision::birth(Event& event,SmObject* object) {
    auto* entry=ledger.binding(object,true);
    require(entry && !entry->alive,"subdivision constructor must issue a fresh generation");
    const auto address=entry->address; *entry=Ledger::Binding{}; entry->address=address;
    const auto id=ledger.append(Change::Construct); ledger.replace(entry,id);
    entry->birth_frame=frame; entry->newborn=true; entry->owned_transition=operation; event.after[0]=id;
    return {object,id};
}
std::unique_ptr<SmCurve> EdgeSubdivision::copy(SmCurve* source) {
    require(source && (source->GetType()==SmBSplineCurve_TYPE || source->GetType()==SmLine_TYPE),
        "subdivision requires an exact supported curve representation");
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    checkpoint="curve-support-before-copy";
    auto* basis=static_cast<SmBSplineCurve*>(source);
    diagnostic_object=reinterpret_cast<uintptr_t>(source); diagnostic_type=source->GetType();
    diagnostic_dimension=source->GetDim(); diagnostic_nurb=basis->GetGwNurbPointer()!=nullptr;
    diagnostic_borrowed=basis->IsNurbBorrowed(); diagnostic_attributes=basis->HasAttributes();
#endif
    geometry.scratch.clear(); geometry.curve(source); geometry.scratch.clear(); // bound support before SDK allocation
    SmCurve* result=nullptr;
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    checkpoint="checked-scratch-copy";
#endif
    const auto status=source->Copy(scratch_context,result); std::unique_ptr<SmCurve> owned(result);
    require(status==SM_SUCCESS && result,"subdivision verification copy status");
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    checkpoint="exact-scratch-copy";
#endif
    exact(source,result); return owned;
}
void EdgeSubdivision::exact(SmCurve* expected,SmCurve* actual) {
    try { geometry.require_exact_curve_copy(expected,actual); }
    catch(const AdapterFailure& error) {
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
        if(ledger.failed()==Failure::None) {
            std::fprintf(stderr,"subdivision exact comparison status=%d reason=%s\n",error.status,error.message);
            report_exception();
        }
#endif
        require(false,"subdivision exact curve representation mismatch");
    }
}
std::unique_ptr<SmCurve> EdgeSubdivision::restricted(SmCurve* source,SmExtent1d domain) {
    auto result=copy(source); const auto requested=domain;
    require(result->Trim(domain)==SM_SUCCESS,"subdivision checked restriction status");
    // This receipt authorizes exact interior cuts; knot snapping, trim deletion,
    // UV solver reparameterization and other paths need their own evidence.
    require(domain.GetMin()==requested.GetMin() && domain.GetMax()==requested.GetMax(),
        "subdivision restriction changed requested interval");
    return result;
}
std::vector<uint64_t> EdgeSubdivision::surface(SmObject* object) {
    require(object,"subdivision missing incident surface");
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    checkpoint="incident-surface-support"; diagnostic_object=reinterpret_cast<uintptr_t>(object);
    diagnostic_type=object->GetType(); diagnostic_dimension=0;
    diagnostic_nurb=diagnostic_borrowed=diagnostic_attributes=false;
    if(object->IsKindOf(SmBSplineSurface_TYPE)) {
        auto* basis=static_cast<SmBSplineSurface*>(object);
        diagnostic_nurb=basis->GetGwNurbPointer()!=nullptr; diagnostic_borrowed=basis->IsNurbBorrowed();
        diagnostic_attributes=basis->HasAttributes();
    }
#endif
    geometry.scratch.clear(); geometry.subdivision_surface(object); auto result=geometry.scratch;
    geometry.scratch.clear(); return result;
}
void EdgeSubdivision::start(SmEdge* value) {
    require(++count<=1024,"subdivision operation count exceeded");
    body=ledger.numerical.copy; body_generation=ledger.numerical.copy_generation;
    live(body,body_generation);
    require(value->GetBrep()==body && body!=ledger.numerical.source,"subdivision requires the witnessed internal copy");
    const auto* binding=ledger.binding(value,false);
    require(binding && binding->birth_frame==frame,"subdivision edge lacks observed constructor");
    edge=value; edge_generation=binding->current; live(edge,edge_generation);
    interval=edge->GetInterval(); tolerance=edge->GetTolerance();
    require(std::isfinite(interval.GetMin()) && std::isfinite(interval.GetMax()) && interval.GetMin()<interval.GetMax() &&
        std::isfinite(tolerance) && tolerance>0,"invalid subdivision interval or tolerance");
    curve=edge->GetCurve(); const auto* cb=ledger.binding(curve,false);
    require(cb && curve->GetOwner()==edge,"subdivision curve lacks observed ownership");
    curve_generation=cb->current; live(curve,curve_generation);
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    geometry_role="edge-3d";
#endif
    frozen=copy(curve);
    require(edge->GetEdgeuseCount()>0 && edge->GetEdgeuseCount()<=16 && edge->GetEdgeuseCount()%2==0,
        "subdivision incident use bound");
    SmTArray<SmEdgeuse*> actual; require(edge->GetEdgeuses(actual)==SM_SUCCESS,"subdivision use inventory status");
    require(actual.GetSize()==edge->GetEdgeuseCount(),"subdivision use inventory count");
    faces.clear(); uses.clear(); links.clear();
    for(auto* use:actual) {
        const auto* ub=ledger.binding(use,false);
        require(ub && use->GetEdge()==edge && use->IsLoopEdgeuse() && use->GetBrep()==body,
            "subdivision incident use ownership");
        live(use,ub->current);
        Use item; item.original=use; item.generation=ub->current; item.face=use->GetFace(); item.loop=use->GetLoopuse();
        item.vertex=use->GetVertexuse(); item.cw=use->GetCWEdgeuse(); item.ccw=use->GetCCWEdgeuse(); item.orientation=use->GetOrientation();
        item.uv=use->GetUVTrimCurvePointer();
        if(item.uv) {
            const auto* uv=ledger.binding(item.uv,false);
            require(uv && item.uv->GetOwner()==use && item.uv->GetDim()==2,"subdivision UV origin ownership");
            item.uv_generation=uv->current; live(item.uv,item.uv_generation);
            for(const auto& helper:ledger.bindings)
                require(!helper.alive || helper.retired || helper.numerical_parent!=item.uv_generation,
                    "subdivision cannot change an origin with a live helper");
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
            geometry_role="installed-uv";
#endif
            item.frozen=copy(item.uv);
            const auto domain=item.uv->GetNaturalInterval();
            require(domain.GetMin()==interval.GetMin() && domain.GetMax()==interval.GetMax(),"subdivision UV/edge domain mismatch");
        }
        require(item.face && item.loop && item.vertex && item.cw && item.ccw,"incomplete subdivision loop");
        uses.push_back(std::move(item));
    }
    for(const auto& use:uses) for(auto* item:{use.original,use.cw,use.ccw}) {
        bool seen=false; for(const auto& link:links) seen|=link.object==item;
        if(!seen) links.push_back({item,item->GetCWEdgeuse(),item->GetCCWEdgeuse()});
    }
    SmTArray<SmFace*> incident; edge->GetFaces(incident);
    require(incident.GetSize()>0 && incident.GetSize()<=16,"subdivision face bound");
    for(auto* face:incident) {
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
        checkpoint="incident-face-identity"; geometry_role="incident-surface";
#endif
        const auto id=ledger.identity(face);
        require(face->GetBrep()==body,"foreign subdivision incident face");
        faces.push_back({face,face->GetSurface(),id,surface(face->GetSurface())});
    }
    child={}; vertex={}; child_curve={}; index=0; step=0; stage=Faces;
}
void EdgeSubdivision::next_uv() {
    while(index<uses.size() && !uses[index].uv) ++index;
    stage=index==uses.size()?AddVertex:UVBirth;
}
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
void EdgeSubdivision::report_exception() const noexcept {
    std::fprintf(stderr,"subdivision exception checkpoint=%s role=%s stage=%u step=%u split=%u cut=%.17g "
        "object=%zx type=%ld dim=%u nurb=%u borrowed=%u attributes=%u\n",checkpoint,geometry_role,
        unsigned(stage),step,count,cut,size_t(diagnostic_object),diagnostic_type,diagnostic_dimension,
        unsigned(diagnostic_nurb),unsigned(diagnostic_borrowed),unsigned(diagnostic_attributes));
}
#endif
void EdgeSubdivision::finish() {
    require(stage==Idle,"subdivision missing matching completion receipt"); // subdivision-completion
}
}
