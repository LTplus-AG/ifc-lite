// SPDX-License-Identifier: MPL-2.0
#include "edge_subdivision.hpp"
#include <SmBSplineCurve.h>
#include <SmBrep.h>
namespace face_lineage {
bool EdgeSubdivision::event(Event& record,SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    if(stage==Idle && !(op==SM_NO_PRE_EDIT && caller && caller->GetType()==SmEdge_TYPE)) return false;
    require(ledger.numerical.source && ledger.numerical.tessellation && ledger.numerical.operation==operation &&
        ledger.frame_count==frame && ledger.numerical.serial==serial &&
        ledger.frames[frame-1]->serial==serial,"subdivision phase authority expired");
    if(stage==Idle) {
        require(a==caller && b==ledger.numerical.copy && !c,"subdivision initial PRE receipt slots");
        start(static_cast<SmEdge*>(caller)); record.before[0]=edge_generation; return true;
    }
    require(++step<=256,"subdivision event budget");
    live(body,body_generation); live(edge,edge_generation); live(curve,curve_generation);
    auto expect=[&](SmNotifyOperation operation,SmObject* object,SmObject* x=nullptr,SmObject* y=nullptr,SmObject* z=nullptr) {
        require(op==operation && caller==object && a==x && b==y && c==z,"subdivision notification order or slots changed");
    };
    auto construct=[&](SM_TYPE type,SmObject* origin=nullptr) {
        require(caller && caller->GetType()==type && caller->GetContext()==body->GetContext(),"subdivision constructor class/context");
        expect(SM_NO_CONSTRUCTION,caller,caller,origin); return birth(record,caller);
    };
    switch(stage) {
    case Faces:
        expect(SM_NO_PRE_EDIT,faces[index].face,faces[index].face,body);
        live(faces[index].face,faces[index].identity); record.before[0]=faces[index].identity;
        if(++index==faces.size()) { index=0; stage=EdgeBirth; } break;
    case EdgeBirth: child=construct(SmEdge_TYPE); stage=VertexBirth; break;
    case VertexBirth: vertex=construct(SmVertex_TYPE); stage=CurveBirth; break;
    case CurveBirth: child_curve=construct(SmCurve_TYPE,curve); stage=EdgeGeometry; break;
    case EdgeGeometry:
        expect(SM_NO_CHANGE_GEOMETRY,child.object,child_curve.object);
        live(child.object,child.generation); stage=CurveOwner; break;
    case CurveOwner:
        expect(SM_NO_CHANGE_OWNER,child_curve.object,child.object);
        live(child_curve.object,child_curve.generation); stage=CurveSplit; break;
    case CurveSplit: {
        expect(SM_NO_SPLIT,curve,curve,child_curve.object,edge);
        auto* next=static_cast<SmEdge*>(child.object); auto* next_curve=static_cast<SmCurve*>(child_curve.object);
        require(next->GetCurve()==next_curve && next_curve->GetOwner()==next && curve->GetOwner()==edge,
            "subdivision 3D copy ownership");
        first=edge->GetInterval(); second=next->GetInterval();
        const bool same=uses[0].orientation==SM_OT_SAME;
        const auto lo=same?first:second,hi=same?second:first; cut=lo.GetMax();
        require(lo.GetMin()==interval.GetMin() && hi.GetMax()==interval.GetMax() && hi.GetMin()==cut &&
            cut>interval.GetMin() && cut<interval.GetMax(),"subdivision exact interval partition"); // subdivision-partition
        exact(frozen.get(),curve); exact(frozen.get(),next_curve);
        expected_first=restricted(frozen.get(),first,&first); expected_second=restricted(frozen.get(),second,&second);
        const auto actual_lo=same?first:second,actual_hi=same?second:first;
        require(actual_lo.GetMin()==interval.GetMin() && actual_hi.GetMax()==interval.GetMax() &&
            actual_lo.GetMax()==actual_hi.GetMin() && actual_lo.GetMax()>interval.GetMin() &&
            actual_lo.GetMax()<interval.GetMax(),"subdivision checked restrictions must share one exact interior cut");
        cut=actual_lo.GetMax();
        require(expected_first->EvaluatePoint(cut,point)==SM_SUCCESS,"subdivision vertex evaluator status");
        stage=OldPre; break;
    }
    case OldPre: expect(SM_NO_PRE_EDIT,curve,curve); stage=OldPost; break;
    case OldPost:
        expect(SM_NO_POST_EDIT,curve,curve); exact(expected_first.get(),curve); stage=NewPre; break;
    case NewPre: expect(SM_NO_PRE_EDIT,child_curve.object,child_curve.object); stage=NewPost; break;
    case NewPost:
        expect(SM_NO_POST_EDIT,child_curve.object,child_curve.object);
        exact(expected_second.get(),static_cast<SmCurve*>(child_curve.object)); stage=Point; break;
    case Point:
        expect(SM_NO_CHANGE_GEOMETRY,vertex.object); live(vertex.object,vertex.generation);
        index=0; stage=UseBirth; break; // SetPoint notifies before assigning; verified at completion.
    case UseBirth: uses[index].child=construct(SmEdgeuse_TYPE); stage=VertexUseBirth; break;
    case VertexUseBirth:
        uses[index].child_vertex=construct(SmVertexuse_TYPE);
        if(++index==uses.size()) { index=0; next_uv(); } else stage=UseBirth;
        break;
    case UVBirth: {
        auto& use=uses[index]; live(use.uv,use.uv_generation);
        use.child_uv=construct(SmCurve_TYPE,use.uv);
        // SDK uses the first mate's orientation for both UV restrictions.
        const bool same=uses[index-index%2].orientation==SM_OT_SAME;
        const SmExtent1d lo(interval.GetMin(),cut),hi(cut,interval.GetMax());
        expected_first=restricted(use.frozen.get(),same?lo:hi);
        expected_second=restricted(use.frozen.get(),same?hi:lo);
        stage=UVPre; break;
    }
    case UVPre: expect(SM_NO_PRE_EDIT,uses[index].uv,uses[index].uv); stage=UVPost; break;
    case UVPost:
        expect(SM_NO_POST_EDIT,uses[index].uv,uses[index].uv);
        exact(expected_first.get(),uses[index].uv); stage=UVNewPre; break;
    case UVNewPre:
        expect(SM_NO_PRE_EDIT,uses[index].child_uv.object,uses[index].child_uv.object); stage=UVNewPost; break;
    case UVNewPost:
        expect(SM_NO_POST_EDIT,uses[index].child_uv.object,uses[index].child_uv.object);
        exact(expected_second.get(),static_cast<SmCurve*>(uses[index].child_uv.object)); stage=TempDeath; break;
    case TempDeath: {
        // The stack SmCrvOnSurf has no construction notification. Its base
        // destructor cannot retire ANY observed live generation or issue one.
        require(caller && caller->GetType()==SmCurve_TYPE,"subdivision temporary destructor class");
        expect(SM_NO_DESTRUCTION,caller,caller);
        const auto* known=ledger.binding(caller,false);
        require(!known || !known->alive,"subdivision temporary destructor aliases a live generation");
        ++index; next_uv(); break;
    }
    case AddVertex: expect(SM_NO_ADD_TO_BREP,body,vertex.object,body); stage=Complete; break;
    case Complete:
        expect(SM_NO_SPLIT_IN_BREP,body,edge,edge,child.object);
        complete(); record.before[0]=edge_generation; record.after[0]=edge_generation; record.after[1]=child.generation;
        stage=Idle; break;
    case Idle: break;
    }
    return true;
}
}
