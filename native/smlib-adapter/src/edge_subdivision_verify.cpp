// SPDX-License-Identifier: MPL-2.0
#include "edge_subdivision.hpp"
#include <SmBSplineCurve.h>
namespace face_lineage {
void EdgeSubdivision::complete() {
    live(child.object,child.generation); live(child_curve.object,child_curve.generation); live(vertex.object,vertex.generation);
    auto* next=static_cast<SmEdge*>(child.object); auto* v=static_cast<SmVertex*>(vertex.object);
    require(edge->GetBrep()==body && next->GetBrep()==body && v->GetBrep()==body &&
        edge->GetCurve()==curve && next->GetCurve()==child_curve.object && curve->GetOwner()==edge &&
        static_cast<SmCurve*>(child_curve.object)->GetOwner()==next,"subdivision completed ownership");
    const auto one=edge->GetInterval(),two=next->GetInterval();
    require(one.GetMin()==first.GetMin() && one.GetMax()==first.GetMax() &&
        two.GetMin()==second.GetMin() && two.GetMax()==second.GetMax(),"subdivision completed interval partition");
    auto left=restricted(frozen.get(),first),right=restricted(frozen.get(),second);
    exact(left.get(),curve); exact(right.get(),static_cast<SmCurve*>(child_curve.object)); // subdivision-exact-curves
    const auto actual=v->GetPoint();
    require(actual.x==point.x && actual.y==point.y && actual.z==point.z &&
        edge->GetTolerance()==tolerance && next->GetTolerance()==tolerance && v->GetTolerance()==tolerance,
        "subdivision vertex or fixed tolerances changed");
    require(edge->GetEdgeuseCount()==uses.size() && next->GetEdgeuseCount()==uses.size() && v->GetSize()==uses.size(),
        "subdivision completed topology counts");
    for(const auto& face:faces) {
        live(face.face,face.identity);
        require(face.face->GetBrep()==body && face.face->GetSurface()==face.surface &&
            surface(face.surface)==face.representation,"subdivision incident surface or identity changed");
    }
    for(const auto& use:uses) links.push_back({static_cast<SmEdgeuse*>(use.child.object),nullptr,nullptr});
    auto link=[&](SmEdgeuse* object)->Link& {
        for(auto& item:links) if(item.object==object) return item;
        require(false,"subdivision adjacency escaped bounded inventory"); return links.front();
    };
    for(size_t i=0;i<uses.size();++i) {
        auto& old=link(uses[i].original); auto& added=link(static_cast<SmEdgeuse*>(uses[i].child.object));
        if(i%2==0) { added.ccw=old.ccw; link(added.ccw).cw=added.object; old.ccw=added.object; added.cw=old.object; }
        else { added.cw=old.cw; link(added.cw).ccw=added.object; old.cw=added.object; added.ccw=old.object; }
    }
    for(const auto& item:links) require(item.object->GetCWEdgeuse()==item.cw && item.object->GetCCWEdgeuse()==item.ccw,
        "subdivision completed loop adjacency");
    for(size_t i=0;i<uses.size();++i) {
        auto& use=uses[i]; auto* old=use.original; auto* added=static_cast<SmEdgeuse*>(use.child.object);
        auto* new_vu=static_cast<SmVertexuse*>(use.child_vertex.object);
        live(old,use.generation); live(added,use.child.generation); live(new_vu,use.child_vertex.generation);
        require(old->GetEdge()==edge && added->GetEdge()==next && old->GetBrep()==body && added->GetBrep()==body &&
            old->GetFace()==use.face && added->GetFace()==use.face && old->GetLoopuse()==use.loop && added->GetLoopuse()==use.loop &&
            old->GetOrientation()==use.orientation && added->GetOrientation()==use.orientation &&
            new_vu->GetVertex()==v && new_vu->GetEdgeuse()==(i%2?old:added),"subdivision incidence or orientation changed");
        if(i%2==0) {
            require(old->GetVertexuse()==use.vertex && added->GetVertexuse()==new_vu,
                "subdivision first mate linkage");
        } else {
            require(old->GetVertexuse()==new_vu && added->GetVertexuse()==use.vertex,
                "subdivision second mate linkage");
        }
        if(!use.uv) {
            require(!old->GetUVTrimCurvePointer() && !added->GetUVTrimCurvePointer(),"subdivision invented UV trim"); continue;
        }
        live(use.uv,use.uv_generation); live(use.child_uv.object,use.child_uv.generation);
        auto* new_uv=static_cast<SmCurve*>(use.child_uv.object);
        require(old->GetUVTrimCurvePointer()==use.uv && added->GetUVTrimCurvePointer()==new_uv &&
            use.uv->GetOwner()==old && new_uv->GetOwner()==added,"subdivision UV completed attachment");
        const bool same=uses[i-i%2].orientation==SM_OT_SAME;
        const SmExtent1d lo(interval.GetMin(),cut),hi(cut,interval.GetMax());
        auto uv_first=restricted(use.frozen.get(),same?lo:hi),uv_second=restricted(use.frozen.get(),same?hi:lo);
        exact(uv_first.get(),use.uv); exact(uv_second.get(),new_uv);
        // A verified child is an installed internal original. Only its later
        // observed unattached helper copies may use the numerical trim path.
        for(auto* uv:{use.uv,new_uv}) {
            auto* entry=ledger.binding(uv,false); auto* owner=static_cast<SmEdgeuse*>(uv->GetOwner());
            entry->subdivision_operation=operation; entry->subdivision_attachment=owner;
            entry->subdivision_owner=ledger.binding(owner,false)->current;
            entry->numerical_operation=operation; entry->numerical_internal_original=true;
        }
    }
    // The pinned SDK emits this receipt after all insertions, then assigns its
    // output pointers and returns SM_SUCCESS (SmBrep.cpp:21598-21642). There is
    // no edge POST_EDIT. Final SDK status/report and phase closure are still
    // mandatory in NumericalRead::tessellate; this is not status substitution.
    frozen.reset(); expected_first.reset(); expected_second.reset(); faces.clear(); uses.clear();
}
}
