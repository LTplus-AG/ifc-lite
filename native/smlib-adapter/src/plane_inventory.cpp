// SPDX-License-Identifier: MPL-2.0
#include "plane_inventory.hpp"
#include "plane_interval.hpp"
#include "context_metadata.hpp"
#include <SmBrep.h>
#include <SmCopyBrepMap.h>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmCone.h>
#include <SmPlane.h>
#include <SmLine.h>
#include <SmEllipse.h>
#include <SmCircle.h>
#include <SmFace.h>
#include <SmFaceuse.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
#include <SmRegion.h>
#include <SmShell.h>
#include <cstring>
#include <unordered_set>
namespace {
using namespace plane_numeric;
struct Inventory {
    SmBrep* brep;
    SmCopyBrepMap* map;
    bool uv;
    std::vector<uint64_t> words;
    std::unordered_set<uint64_t> expected_loops,seen_loops,seen_uses,seen_vertices;
    void put(uint64_t v) {
        require(words.size()<4000000,"plane inventory word budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
        words.push_back(v);
    }
    void real(double v) {
        require(std::isfinite(v),"nonfinite plane inventory value");
        uint64_t bits; std::memcpy(&bits,&v,sizeof bits); put(bits);
    }
    template<class T> void xyz(const T& p) { real(p.x); real(p.y); real(p.z); }
    uint64_t id(SmTopology* p) {
        if(!p) return 0;
        require(p->GetBrep()==brep,"foreign plane inventory topology");
        if(map) {
            p=map->GetAt(p);
            require(p && p->GetBrep()==map->GetOrigBrep(),"incomplete plane copy map");
        }
        return reinterpret_cast<uintptr_t>(p);
    }
    template<class T> std::vector<T*> ordered(const SmTArray<T*>& array) {
        require(array.GetSize()<=400000,"plane inventory object budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
        std::vector<T*> result;
        std::unordered_set<uint64_t> seen;
        for(auto* p:array) {
            const auto key=id(p);
            require(key && seen.insert(key).second,"duplicate/null plane inventory object");
            result.push_back(p);
        }
        std::sort(result.begin(),result.end(),[&](auto* a,auto* b){return id(a)<id(b);});
        put(result.size()); return result;
    }
    void orientation(SmOrientType value) {
        require(value==SM_OT_SAME || value==SM_OT_OPPOSITE,"unknown plane inventory orientation");
        put(value);
    }
    void boolean(SmBoolean value) {
        require(value==TRUE || value==FALSE || value==UNSURE,"unknown plane inventory boolean");
        put(value);
    }
    template<class T> void complete(const SmTArray<T*>& all,const std::unordered_set<uint64_t>& seen) {
        std::unordered_set<uint64_t> actual;
        for(auto* item:ordered(all)) actual.insert(id(item));
        require(actual==seen,"incomplete plane inventory traversal");
    }
    void values(const double* p,size_t n) {
        require(p && n && n<=1000000,"plane inventory coefficient budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
        put(n); for(size_t i=0;i<n;++i) real(p[i]);
    }
    void curve(SmBSplineCurve* c) {
        if(!c) { put(0); return; }
        const auto type=c->GetType();
        require(type==SmBSplineCurve_TYPE || type==SmLine_TYPE || type==SmCircle_TYPE ||
            type==SmEllipse_TYPE,"unknown plane inventory curve");
        require(c->GetGwNurbPointer(),"unmaterialized plane inventory curve");
        put(type); put(c->GetDegree()); put(c->GetDim());
        put(c->IsBounded()); put(c->IsOutOfBoundsEnabled());
        const auto interval=c->GetNaturalInterval(); real(interval.GetMin()); real(interval.GetMax());
        ULONG n=0; double* p=nullptr; checked(c->GetControlPointsPointer(n,p));
        require(n && n<=250000,"plane inventory curve controls",IFCLITE_SMLIB_RESOURCE_LIMIT);
        values(p,size_t(n)*4);
        SmTArray<double> k; checked(c->GetKnotsAll(k)); values(k.GetDataArray(),k.GetSize());
        if(type==SmCircle_TYPE || type==SmEllipse_TYPE) {
            SmAxis2Placement frame; double radius_x,radius_y; SmExtent1d step; SmBoolean inside;
            checked(static_cast<SmEllipse*>(c)->SmEllipse::GetCanonical(frame,radius_x,radius_y,&step,&inside));
            xyz(frame.GetOrigin()); xyz(frame.GetXAxis()); xyz(frame.GetYAxis()); xyz(frame.GetZAxis());
            real(radius_x); real(radius_y); real(step.GetMin()); real(step.GetMax()); put(inside);
        }
        if(type==SmLine_TYPE) {
            SmPoint3d origin; SmVector3d axis; double scale; SmExtent1d step; SmBoolean inside;
            checked(static_cast<SmLine*>(c)->GetCanonical(origin,axis,scale,step,&inside));
            xyz(origin); xyz(axis); real(scale); real(step.GetMin()); real(step.GetMax()); put(inside);
        }
    }
    void surface(SmFace* f) {
        auto* s=f->GetSurface();
        require(s && s->GetOwner()==f,"foreign plane inventory surface");
        const auto type=s->GetType();
        require(type==SmBSplineSurface_TYPE || type==SmPlane_TYPE || type==SmCone_TYPE ||
            type==SmCylinder_TYPE,"unknown plane inventory surface");
        auto* b=static_cast<SmBSplineSurface*>(s);
        require(b->GetGwNurbPointer(),"unmaterialized plane inventory surface");
        put(type); put(b->GetBSplineSurfaceForm()); put(b->IsOutOfBoundsEnabled());
        boolean(s->IsUsingNewPointSolvers()); // raw policy getter; no point solve
        put(b->GetDegree(SM_SP_U)); put(b->GetDegree(SM_SP_V));
        ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
        checked(b->GetControlPointsPointer(nu,nv,p)); checked(b->GetKnotsPointers(ku,kv,u,v));
        require(nu && nv && nu<=250000/nv,"plane inventory surface controls",IFCLITE_SMLIB_RESOURCE_LIMIT);
        put(nu); put(nv); values(p,size_t(nu)*nv*4); values(u,ku); values(v,kv);
        if(type==SmPlane_TYPE) {
            auto* plane=static_cast<SmPlane*>(s); const auto& frame=plane->GetPosition();
            xyz(frame.GetOrigin()); xyz(frame.GetXAxis()); xyz(frame.GetYAxis());
            const auto scale=plane->GetUVScale(); real(scale.x); real(scale.y);
        }
        if(type==SmCone_TYPE || type==SmCylinder_TYPE) {
            SmAxis2Placement frame; double radius,angle; SmBoolean swap,inside;
            auto* cone=static_cast<SmCone*>(s);
            checked(cone->SmCone::GetCanonical(frame,radius,angle,&swap,&inside));
            xyz(frame.GetOrigin()); xyz(frame.GetXAxis()); xyz(frame.GetYAxis()); xyz(frame.GetZAxis());
            real(radius); real(angle); put(swap); put(inside);
            const auto step=cone->GetSTEPUVDomain();
            real(step.GetUMin()); real(step.GetUMax()); real(step.GetVMin()); real(step.GetVMax());
            curve(cone->GetGenCurve());
        }
    }
    void edgeuse(SmEdgeuse* use,SmLoopuse* lu,SmFace* f) {
        require(use && use->GetType()==SmEdgeuse_TYPE && use->GetEdgeuseType()==SmLoopuse_TYPE &&
            use->GetFace()==f && use->GetLoopuse()==lu && use->GetFaceuse()==lu->GetFaceuse(),
            "foreign plane inventory use");
        require(seen_uses.insert(id(use)).second,"duplicate plane inventory edgeuse");
        auto* mate=use->GetMate(); auto* cw=use->GetCWEdgeuse(); auto* ccw=use->GetCCWEdgeuse();
        require(mate && mate->GetMate()==use && mate->GetEdge()==use->GetEdge() &&
            mate->GetLoopuse()==lu->GetOtherLoopuse() && cw && ccw &&
            cw->GetCCWEdgeuse()==use && ccw->GetCWEdgeuse()==use &&
            cw->GetLoopuse()==lu && ccw->GetLoopuse()==lu,"nonreciprocal plane inventory adjacency");
        put(id(use)); put(use->GetEdgeuseType()); put(id(use->GetEdge())); put(id(mate));
        put(id(use->GetRadial())); put(id(use->GetNext())); put(id(use->GetLast()));
        put(id(cw)); put(id(ccw)); orientation(use->GetOrientation());
        auto* vu=use->GetVertexuse();
        require(vu && vu->GetType()==SmVertexuse_TYPE && vu->GetVertexuseType()==SmEdgeuse_TYPE &&
            vu->GetEdgeuse()==use && vu->GetLoopuse()==lu && vu->GetFaceuse()==lu->GetFaceuse() &&
            vu->GetVertex() && seen_vertices.insert(id(vu)).second,"foreign plane inventory vertexuse");
        put(id(vu)); put(vu->GetVertexuseType()); put(id(vu->GetVertex()));
        put(id(vu->GetEdgeuse())); put(id(vu->GetLoopuse())); put(id(vu->GetFaceuse()));
        put(id(vu->GetNext())); put(id(vu->GetLast()));
        if(uv) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            require(mate->GetFace()==f && !(use->GetUVTrimCurvePointer() && mate->GetUVTrimCurvePointer()),
                "ambiguous or foreign plane inventory mate trim");
            require(!trim || (owner && owner->GetFace()==f && trim->GetOwner()==owner),
                "foreign plane inventory trim");
            // A saved DropCurve failure changes GetOrCreateUVTrimCurve's
            // return status even with present trims; no opaque failure state.
            require(!use->GetDropCurveFail(),"unsupported plane inventory drop-failure state");
            put(trim?id(owner):0); curve(trim);
        }
    }
    void loopuse(SmLoopuse* lu,SmLoopuse* primary,SmLoop* loop,SmFace* f) {
        require(lu && lu->GetType()==SmLoopuse_TYPE && lu->GetLoop()==loop &&
            lu->GetFaceuse() && lu->GetFaceuse()->GetFace()==f &&
            lu->GetLoopuseType()==SmEdgeuse_TYPE,"unknown or foreign plane inventory loopuse");
        require(seen_loops.insert(id(lu)).second,"duplicate plane inventory loopuse");
        put(id(lu)); put(id(lu->GetOtherLoopuse())); put(id(lu->GetFaceuse()));
        put(lu->GetLoopuseType()); put(id(lu->GetEUorVU()));
        put(id(lu->GetNext())); put(id(lu->GetLast()));
        orientation(lu->GetOrientation()); // both sides, including the nonprimary loopuse
        put(lu==primary); // distinguish the SDK's primary-side traversal
        // Bound the actual CCW cursor walk before calling any SDK list helper.
        auto* first=lu->GetEUorVU();
        require(first && first->GetType()==SmEdgeuse_TYPE,"unknown plane inventory cycle head");
        auto* start=static_cast<SmEdgeuse*>(first); auto* cursor=start;
        SmTArray<SmEdgeuse*> uses; std::unordered_set<SmEdgeuse*> visited;
        do {
            require(cursor && visited.size()<400000 && visited.insert(cursor).second,
                "unclosed or oversized plane inventory edge cycle");
            require(cursor->GetType()==SmEdgeuse_TYPE && cursor->GetLoopuse()==lu,
                "foreign plane inventory cycle member");
            uses.Add(cursor); cursor=cursor->GetCCWEdgeuse();
        } while(cursor!=start);
        for(auto* use:ordered(uses)) edgeuse(use,lu,f);
    }
    void face(SmFace* f) {
        put(id(f)); put(f->GetType()); real(f->GetTolerance()); surface(f);
        if(uv) {
            // Reconstruction may legitimately update this derived policy,
            // but copy, source preservation and the final seal compare it.
            boolean(f->GetRectangularTrim());
            const auto domain=f->GetUVDomain();
            real(domain.GetUMin()); real(domain.GetUMax()); real(domain.GetVMin()); real(domain.GetVMax());
        }
        SmTArray<SmLoop*> loops; f->GetLoops(loops);
        for(auto* loop:ordered(loops)) {
            require(loop->GetType()==SmLoop_TYPE && loop->GetFace()==f && loop->GetLoopuse(),
                "unknown or foreign plane inventory loop");
            auto* primary=loop->GetLoopuse(); auto* other=primary->GetOtherLoopuse();
            require(other && other!=primary && other->GetOtherLoopuse()==primary &&
                primary->GetFaceuse() && other->GetFaceuse()==primary->GetFaceuse()->GetMate(),
                "nonreciprocal plane inventory loopuses");
            put(id(loop)); put(id(primary)); put(id(other));
            loopuse(primary,primary,loop,f); loopuse(other,primary,loop,f);
        }
    }
};
}
std::vector<uint64_t> plane_inventory(SmBrep* brep,bool uv,SmCopyBrepMap* map) {
    using namespace plane_numeric;
    require(brep && brep->GetInfiniteRegion(),"absent plane inventory BRep");
    Inventory r{brep,map,uv,{},{},{},{},{}};
    r.put(brep->GetInfiniteRegion()->IsVoid()); r.real(brep->GetTolerance());
    const auto metadata=raw_context::Access<SmBrep>::get(*brep);
    const auto context=raw_context::Access<SmContext>::get(*brep->GetContext());
    for(const auto& m:{metadata,context}) { r.real(m.size); r.real(m.ratio); r.real(m.zone); }
    SmTArray<SmRegion*> regions; brep->GetRegions(regions);
    for(auto* region:r.ordered(regions)) {
        r.put(r.id(region)); r.put(region->IsVoid());
        SmTArray<SmShell*> shells; region->GetShells(shells);
        for(auto* shell:r.ordered(shells)) {
            require(shell->GetRegion()==region,"foreign plane inventory shell"); r.put(r.id(shell));
            SmTArray<SmFaceuse*> uses; shell->GetFaceuses(uses);
            for(auto* use:r.ordered(uses)) {
                require(use->GetShell()==shell,"foreign plane inventory faceuse");
                r.put(r.id(use)); r.put(r.id(use->GetFace())); r.put(r.id(use->GetMate()));
                r.orientation(use->GetOrientation());
                SmTArray<SmLoopuse*> loopuses; use->GetLoopuses(loopuses);
                for(auto* lu:r.ordered(loopuses)) {
                    require(lu->GetFaceuse()==use && r.expected_loops.insert(r.id(lu)).second,
                        "foreign or duplicate plane inventory faceuse loop");
                    r.put(r.id(lu));
                }
            }
        }
    }
    SmTArray<SmFace*> faces; brep->GetFaces(faces);
    for(auto* f:r.ordered(faces)) r.face(f);
    SmTArray<SmEdge*> edges; brep->GetEdges(edges);
    for(auto* e:r.ordered(edges)) {
        require(e->GetCurve() && e->GetCurve()->GetOwner()==e,"foreign plane inventory edge curve");
        r.put(r.id(e)); r.put(e->GetType()); r.real(e->GetTolerance());
        r.put(r.id(e->GetPrimaryEdgeuse())); r.put(r.id(e->GetStartVertex())); r.put(r.id(e->GetEndVertex()));
        const auto interval=e->GetInterval(); r.real(interval.GetMin()); r.real(interval.GetMax());
        r.curve(static_cast<SmBSplineCurve*>(e->GetCurve()));
    }
    SmTArray<SmVertex*> vertices; brep->GetVertices(vertices);
    for(auto* v:r.ordered(vertices)) { r.put(r.id(v)); r.real(v->GetTolerance()); r.xyz(v->GetPoint()); }
    require(r.expected_loops==r.seen_loops,"incomplete plane inventory loopuse traversal");
    SmTArray<SmEdgeuse*> all_uses; brep->GetEdgeuses(all_uses); r.complete(all_uses,r.seen_uses);
    SmTArray<SmVertexuse*> all_vertices; brep->GetVertexuses(all_vertices); r.complete(all_vertices,r.seen_vertices);
    return std::move(r.words);
}
