// SPDX-License-Identifier: MPL-2.0
#include "planar_transition_detail.hpp"
#include <SmShell.h>
#include <SmLoopuse.h>
namespace face_lineage {
using namespace planar_detail;
PlanarTransition::PlanarTransition(Ledger& value,SmBrep& immutable,SmBrep& owned,SmFace& target):
    ledger(value),source(immutable),working(owned),face(target) {
    require(&source!=&working && source.GetContext()==working.GetContext() && face.GetBrep()==&working,
        "transition requires distinct actual source/working ownership");
    auto* target_binding=ledger.binding(&working,false);
    require(target_binding && target_binding->alive && !target_binding->retired &&
        ledger.node(target_binding->current) && ledger.node(target_binding->current)->change==Change::Construct,
        "transition target requires its actual observed BRep constructor generation");
    target_generation=target_binding->current;
    ledger.verify_inventory(source); ledger.verify_inventory(working);
    require(working.GetNumFaces()<=64 && working.GetNumEdges()<=128 && working.GetNumVertices()<=128 &&
        working.IsManifoldSolid(),"transition bounded closed manifold subset");
    source_seal=std::make_unique<RepresentationSeal>(ledger,source);
    pre_seal=std::make_unique<RepresentationSeal>(ledger,working);
    receipt.parent=ledger.identity(&face); frame=ledger.frame_count;
    require(frame>=2,"transition requires an actual enclosing continuous owner frame");
    parent_frame_serial=ledger.frames[frame-2]->serial;
    pre_faces=working.GetNumFaces(); pre_edges=working.GetNumEdges(); pre_vertices=working.GetNumVertices();
    SmTArray<SmFace*> originals; source.GetFaces(originals); unsigned ancestors=0;
    for(auto* original:originals) ancestors+=ledger.descends_from(receipt.parent,ledger.identity(original));
    require(ancestors==1,"transition face must derive from exactly one actual sealed source face");
    require(face.GetType()==SmFace_TYPE && face.GetSurface()->GetType()==SmPlane_TYPE,
        "transition supports only actual generic face on analytic plane");
    support=static_cast<SmPlane*>(face.GetSurface()); domain=face.GetUVDomain(); old_rect=face.GetRectangularTrim();
    const auto& position=support->GetPosition(); const auto x=position.GetXAxis(),y=position.GetYAxis(),z=position.GetZAxis();
    const SmVector3d cross(x.y*y.z-x.z*y.y,x.z*y.x-x.x*y.z,x.x*y.y-x.y*y.x);
    const auto scale=support->GetUVScale();
    require(axis(x) && axis(y) && axis(z) && x.Dot(y)==0 && x.Dot(z)==0 && y.Dot(z)==0 && point(cross,z) &&
        std::isfinite(scale.x) && std::isfinite(scale.y) && scale.x!=0 && scale.y!=0 &&
        std::isfinite(domain.GetUMin()) && std::isfinite(domain.GetUMax()) && std::isfinite(domain.GetVMin()) &&
        std::isfinite(domain.GetVMax()) && domain.GetUMin()<domain.GetUMax() && domain.GetVMin()<domain.GetVMax(),
        "transition exact axis-plane rectangular domain subset");
    SmTArray<SmLoop*> loops; face.GetLoops(loops); SmTArray<SmEdgeuse*> uses; face.GetUpwardEdgeuses(uses);
    SmTArray<SmVertex*> vertices; face.GetVertices(vertices);
    require(loops.GetSize()==1 && loops[0]->IsOuterLoop() && loops[0]->IsClosedPtrs() && uses.GetSize()==4 &&
        vertices.GetSize()==4 && (old_rect==TRUE || old_rect==UNSURE),"transition requires one actual rectangular outer loop");
    for(unsigned i=0;i<4;++i) {
        uv[i]=SmPoint3d(i&1?domain.GetUMax():domain.GetUMin(),i&2?domain.GetVMax():domain.GetVMin(),0);
        checked(support->EvaluatePoint(SmPoint2d(uv[i].x,uv[i].y),points[i]),"transition plane corner evaluation");
        require(std::isfinite(points[i].x) && std::isfinite(points[i].y) && std::isfinite(points[i].z),
            "transition finite exact represented corner");
        unsigned hits=0; for(auto* vertex:vertices) if(point(vertex->GetPoint(),points[i])) { corners[i]=vertex; ++hits; }
        require(hits==1,"transition exact unique actual plane corner");
        for(unsigned j=0;j<i;++j) require(corners[j]!=corners[i],"transition duplicate corner inventory");
    }
    for(unsigned i=0;i<4;++i) {
        auto& slot=slots[i]; slot.use=uses[i]; slot.original=uses[i]->GetUVTrimCurve();
        slot.original_slot=reinterpret_cast<uintptr_t>(slot.original);
        require(slot.original && !slot.use->GetDropCurveFail(),"transition requires genuine unfailed source UVs");
        owner(slot.use,&face,working,slot.original);
        const auto a=linear(*slot.original,2),b=linear(*static_cast<SmBSplineCurve*>(slot.use->GetEdge()->GetCurve()),3);
        require(slot.use->GetVertexuse() && slot.use->GetMate()->GetVertexuse(),"transition boundary endpoints");
        unsigned from=4,to=4;
        for(unsigned k=0;k<4;++k) {
            if(corners[k]==slot.use->GetVertexuse()->GetVertex()) from=k;
            if(corners[k]==slot.use->GetMate()->GetVertexuse()->GetVertex()) to=k;
        }
        require(from<4 && to<4 && ((from^to)==1 || (from^to)==2),"transition exact rectangle boundary incidence");
        slot.from=from; slot.to=to; const unsigned first=slot.use->GetOrientation()==SM_OT_SAME?0:1;
        require(point(a[first],uv[from]) && point(a[1-first],uv[to]) && point(b[first],points[from]) &&
            point(b[1-first],points[to]),"transition exact UV/3D coefficient correspondence");
        const auto interval=slot.use->GetEdge()->GetInterval(),natural=slot.original->GetNaturalInterval();
        require(interval.GetMin()==0 && interval.GetMax()==1 && bits(interval.GetMin(),natural.GetMin()) &&
            bits(interval.GetMax(),natural.GetMax()),"transition fixed common edge/UV parameter interval");
        for(unsigned j=0;j<i;++j) require(slots[j].use!=slot.use && slots[j].use->GetEdge()!=slot.use->GetEdge(),
            "transition duplicate boundary use/edge inventory");
    }
    original_loop=loops[0];
    original_loop->GetLoopuses(original_loopuses[0],original_loopuses[1]);
    require(original_loopuses[0] && original_loopuses[1] && original_loopuses[0]!=original_loopuses[1],
        "missing original reciprocal loopuses");
    if(original_loopuses[0]->GetFaceuse()->GetOrientation()==SM_OT_OPPOSITE)
        std::swap(original_loopuses[0],original_loopuses[1]);
    for(unsigned i=0;i<2;++i) {
        auto* lu=original_loopuses[i];
        require(lu->GetLoopuseType()==SmEdgeuse_TYPE && lu->GetLoop()==original_loop &&
            lu->GetOtherLoopuse()==original_loopuses[1-i] && lu->GetFaceuse()->GetFace()==&face &&
            lu->GetFaceuse()->GetOrientation()==(i?SM_OT_OPPOSITE:SM_OT_SAME),"original loopuse orientation/owner subset");
        original_heads[i]=static_cast<SmEdgeuse*>(lu->GetEUorVU());
        require(original_heads[i] && original_heads[i]->GetLoopuse()==lu,"missing original primary-use owner slot");
    }
    // Fixed audited numerical reads occur before issuing the mutation plan.
    pre_volume=NumericalRead::volume(ledger,working,1e-8);
    auto* use=face.GetUpwardFaceuse(); if(use->GetShell()->GetRegion()==working.GetInfiniteRegion()) use=use->GetMate();
    const auto properties=NumericalRead::face(ledger,face,use->GetOrientation(),1e-8,SmPoint3d(0,0,0),1.);
    pre_area=properties.area; pre_face_volume=properties.volume;
    require(pre_area>0 && std::isfinite(pre_area) && std::isfinite(pre_face_volume) && std::isfinite(pre_volume),"transition signed pre-properties");
    source_seal->verify(); pre_seal->verify();
    receipt.operation=ledger.append(Change::AuditBoundary); ledger.check();
    // Original slot generations must have actual observed constructors in the
    // owned copy. A seal alone cannot recover unknown prior physical history.
    issue_slot(original_loop);
    for(auto* lu:original_loopuses) { issue_slot(lu); issue_slot(lu->GetFaceuse()); }
    for(const auto& slot:slots) { issue_slot(slot.use); issue_slot(slot.use->GetMate()); }
    require(original_count==original_slots.size(),"complete preissued original topology slots");
}
SmBSplineCurve* PlanarTransition::construct_curve(unsigned dimension,const SmPoint3d& a,const SmPoint3d& b) {
    copy_source=nullptr; expecting_birth=true; pending_birth=nullptr; pending_generation={};
    SmBSplineCurve* curve=nullptr;
    checked(SmBSplineCurve::CreateLineSegment(*working.GetContext(),dimension,a,b,curve),"transition checked initial line constructor");
    ledger.check(); expecting_birth=false;
    require(curve && pending_birth==curve && pending_generation.sequence,"transition actual constructor receipt missing");
    const auto controls=linear(*curve,dimension);
    require(point(controls[0],a) && point(controls[1],b) && curve->GetNaturalInterval().GetMin()==0 &&
        curve->GetNaturalInterval().GetMax()==1,"transition exact fresh line coefficients/domain");
    return curve;
}
void PlanarTransition::issue_slot(SmTopology* object) {
    require(object && object->GetBrep()==&working && original_count<original_slots.size(),"foreign/excess original topology slot");
    for(unsigned i=0;i<original_count;++i) require(original_slots[i].object!=object,"duplicate original topology slot");
    auto* entry=ledger.binding(object,false); ledger.check();
    require(entry && entry->alive && !entry->retired && !ledger.complete(entry->current),
        "original topology slot has unknown/replaced generation or class authority");
    original_slots[original_count++]={object,object->GetOwner(),entry->current};
}
void PlanarTransition::prepare() {
    line3.reset(construct_curve(3,points[0],points[3])); curve3=line3.get();
    line2.reset(construct_curve(2,uv[0],uv[3])); curve2=line2.get();
    for(auto& slot:slots) {
        copy_source=slot.original; expecting_birth=true; pending_birth=nullptr; pending_generation={};
        SmCurve* raw=nullptr; const auto status=slot.original->Copy(*working.GetContext(),raw);
        slot.retained.reset(static_cast<SmBSplineCurve*>(raw));
        checked(status,"transition retained UV copy status"); ledger.check(); expecting_birth=false;
        require(raw && raw==pending_birth && pending_generation.sequence,"transition retained UV constructor identity");
        slot.birth=pending_generation; pre_seal->require_exact_curve_copy(slot.original,raw);
    }
    copy_source=nullptr; source_seal->verify(); pre_seal->verify();
}
}
