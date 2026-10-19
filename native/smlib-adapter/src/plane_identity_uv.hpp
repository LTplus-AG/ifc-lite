// SPDX-License-Identifier: MPL-2.0
#pragma once
// Fixed producer seam only: construct on the owned checked-copy immediately
// before TurnToNURBS; restore once after BOTH identity transform stages.
// This is not a caller-supplied domain credential or a source mutation API.
#include "plane_domain.hpp"
#include "plane_dyadic.hpp"
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFaceuse.h>
#include <SmShell.h>
#include <SmRegion.h>
#include <SmLine.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <SmPlane.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>
namespace plane_source_proof {
class IdentityUvTransfer {
    using Words=std::vector<uint64_t>;
    struct Trim {
        SmFace* face; SmEdge* edge; SmEdgeuse* use; SmEdgeuse* mate;
        SmBSplineCurve* original; std::unique_ptr<SmBSplineCurve> curve; Words signature;
    };
    SmBrep& owned;
    std::vector<Trim> trims;
    Words before;
    bool active=false,consumed=false;
    unsigned charged=0;
    static void check(bool b,const char* message) { plane_numeric::require(b,message); }
    static void limit(bool b,const char* message) { plane_numeric::require(b,message,IFCLITE_SMLIB_RESOURCE_LIMIT); }
    static void word(Words& w,uint64_t x) { limit(w.size()<32768,"identity UV seal budget"); w.push_back(x); }
    static void endpoints(SmEdge* e) {
        auto* p=e->GetPrimaryEdgeuse();
        check(p && p->GetMate() && p->GetMate()->GetMate()==p && p->GetVertexuse() && p->GetMate()->GetVertexuse() &&
            p->GetVertexuse()->GetVertex() && p->GetMate()->GetVertexuse()->GetVertex() &&
            (p->GetOrientation()==SM_OT_SAME || p->GetOrientation()==SM_OT_OPPOSITE),"identity UV missing actual endpoint topology");
    }
    static void pointer(Words& w,const void* p) { word(w,reinterpret_cast<uintptr_t>(p)); }
    static void real(Words& w,double x) {
        uint64_t bits=0; std::memcpy(&bits,&x,8); word(w,bits);
    }
    static void pair(const double* k,unsigned n) {
        check(k && n==4 && std::isfinite(k[0]) && std::isfinite(k[3]) &&
            k[0]==k[1] && k[2]==k[3] && k[0]<k[3],"identity UV needs clamped degree1 knots");
    }
    void controls(const double* p,unsigned n,unsigned dimensions) {
        check(p,"identity UV absent control data"); limit(n<=1000000-charged,"identity UV coefficient budget"); charged+=n;
        for(unsigned i=0;i<n;++i) {
            check((p[3]==NL_NOW || p[3]==1) && p[4*i+3]==p[3],"identity UV needs uniformly unit-weight controls");
            for(unsigned d=0;d<dimensions;++d) check(std::isfinite(p[4*i+d]),"identity UV nonfinite control");
        }
    }
    static void line_map(SmLine* line,const double* p,unsigned dimensions) {
        SmPoint3d origin; SmVector3d axis; double scale=0; SmExtent1d step; SmBoolean reverse=UNSURE;
        plane_numeric::checked(line->GetCanonical(origin,axis,scale,step,&reverse));
        const auto natural=line->GetNaturalInterval(); const double length=natural.GetMax()-natural.GetMin();
        const double step_length=step.GetMax()-step.GetMin();
        check(line->IsBounded() && std::isfinite(scale) && scale>0 &&
            std::isfinite(step.GetMin()) && std::isfinite(step.GetMax()) && step.GetMin()<step.GetMax() &&
            (reverse==TRUE || reverse==FALSE) && std::isfinite(natural.GetMin()) && std::isfinite(natural.GetMax()) &&
            std::isfinite(length) && length>0 && !SM_IS_ZERO(length),
            "identity UV unsupported analytic line dispatch");
        // SmLine.cpp:459-487 subtracts the STEP ends before multiplying by
        // the normalized NURBS parameter. Finite ends alone do not make that
        // span finite: 0*infinity can invalidate even the first endpoint.
        check(std::isfinite(step_length) && step_length>0,"identity UV nonfinite STEP conversion span");
        double mapped[2]{};
        for(unsigned i=0;i<2;++i) {
            const double t=i?natural.GetMax():natural.GetMin();
            const double offset=t-(reverse?natural.GetMax():natural.GetMin());
            const double ratio=offset/(reverse?-length:length);
            const double scaled=ratio*step_length;
            mapped[i]=step.GetMin()+scaled;
            check(std::isfinite(offset) && std::isfinite(ratio) && ratio>=0 && ratio<=1 &&
                std::isfinite(scaled) && std::isfinite(mapped[i]),"identity UV nonfinite STEP conversion intermediate");
        }
        // Each dispatch stage is monotone on the complete natural interval;
        // finite endpoint extrema bound every interior intermediate. Check
        // the following signed-axis position operations too, without SDK eval.
        unsigned varying=0;
        for(unsigned d=0;d<dimensions;++d) {
            check(std::isfinite(origin[d]) && (axis[d]==0 || axis[d]==1 || axis[d]==-1),
                "identity UV line is not an exact coordinate axis"); varying+=axis[d]!=0;
            for(double t:mapped) {
                const double directed=t*axis[d],scaled=directed*scale,position=origin[d]+scaled;
                check(std::isfinite(directed) && std::isfinite(scaled) && std::isfinite(position),
                    "identity UV nonfinite analytic line position intermediate");
            }
            const bool first=canonical_value(p[d],origin[d],scale,axis[d],reverse?step.GetMax():step.GetMin());
            const bool last=canonical_value(p[4+d],origin[d],scale,axis[d],reverse?step.GetMin():step.GetMax());
            if(!first || !last) std::fprintf(stderr,
                "identity UV exact line-map refusal dim=%u origin=%.17g axis=%.17g scale=%.17g step=(%.17g %.17g) reverse=%d controls=(%.17g %.17g) first=%d last=%d\n",
                d,origin[d],axis[d],scale,step.GetMin(),step.GetMax(),reverse,p[d],p[4+d],first,last);
            check(first && last,"identity UV canonical line differs from actual rational coefficients");
        }
        check(varying==1,"identity UV degenerate line");
    }
    void curve(Words& w,SmBSplineCurve* c,unsigned dimensions,bool analytic) {
        check(c && c->GetGwNurbPointer() && c->GetDim()==dimensions && c->GetDegree()==1 &&
            c->GetNumberNaturalKnots()==4,"identity UV unsupported existing curve");
        ULONG n=0; double* p=nullptr; plane_numeric::checked(c->GetControlPointsPointer(n,p));
        check(n==2,"identity UV curve dimensions"); controls(p,n,dimensions);
        SmTArray<double> k; plane_numeric::checked(c->GetKnotsAll(k)); pair(k.GetDataArray(),k.GetSize());
        word(w,dimensions); for(unsigned i=0;i<8;++i) real(w,p[i]); for(double x:k) real(w,x);
        if(analytic && c->GetType()==SmLine_TYPE) line_map(static_cast<SmLine*>(c),p,dimensions);
    }
    void surface(Words& w,SmBSplineSurface* s,bool analytic) {
        check(s && s->GetGwNurbPointer() && s->GetDegree(SM_SP_U)==1 && s->GetDegree(SM_SP_V)==1 &&
            s->GetBSplineSurfaceForm()!=SM_SF_POLYNOMIAL && s->IsOutOfBoundsEnabled()==FALSE,
            "identity UV unsupported existing surface dispatch");
        ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
        plane_numeric::checked(s->GetControlPointsPointer(nu,nv,p)); plane_numeric::checked(s->GetKnotsPointers(ku,kv,u,v));
        check(nu==2 && nv==2,"identity UV surface dimensions"); controls(p,4,3); pair(u,ku); pair(v,kv);
        for(unsigned i=0;i<16;++i) real(w,p[i]); for(unsigned i=0;i<4;++i) {real(w,u[i]); real(w,v[i]);}
        if(analytic && s->GetType()==SmPlane_TYPE) {
            const auto* plane=static_cast<SmPlane*>(s); const auto& frame=plane->GetPosition();
            const auto o=frame.GetOrigin(),x=frame.GetXAxis(),y=frame.GetYAxis(); const auto scale=plane->GetUVScale();
            const auto domain=plane->GetSTEPUVDomain();
            check(u[0]>=domain.GetUMin() && u[3]<=domain.GetUMax() && v[0]>=domain.GetVMin() && v[3]<=domain.GetVMax() &&
                std::isfinite(scale.x) && scale.x!=0 && std::isfinite(scale.y) && scale.y!=0,
                "identity UV plane support escapes actual unclamped analytic map");
            unsigned ux=3,vx=3;
            for(unsigned d=0;d<3;++d) {
                check(std::isfinite(o[d]) && (x[d]==0 || x[d]==1 || x[d]==-1) &&
                    (y[d]==0 || y[d]==1 || y[d]==-1) && !(x[d]!=0 && y[d]!=0),"identity UV nonaxis plane");
                if(x[d]) { check(ux==3,"identity UV nonaxis U"); ux=d; }
                if(y[d]) { check(vx==3,"identity UV nonaxis V"); vx=d; }
                for(unsigned i=0;i<2;++i) for(unsigned j=0;j<2;++j) {
                    const double q=p[4*(2*i+j)+d];
                    const bool equivalent=x[d]?canonical_value(q,o[d],scale.x,x[d],u[i?3:0]):
                        y[d]?canonical_value(q,o[d],scale.y,y[d],v[j?3:0]):q==o[d];
                    if(!equivalent) std::fprintf(stderr,
                        "identity UV exact plane-map refusal dim=%u corner=(%u %u) origin=%.17g axes=(%.17g %.17g) scales=(%.17g %.17g) uv=(%.17g %.17g) control=%.17g\n",
                        d,i,j,o[d],x[d],y[d],scale.x,scale.y,u[i?3:0],v[j?3:0],q);
                    check(equivalent,"identity UV plane and rational tensor map differ exactly");
                }
            }
            check(ux<3 && vx<3 && ux!=vx,"identity UV singular plane map");
        }
    }
    Words trim_signature(SmBSplineCurve* c) {
        check(c && (c->GetType()==SmLine_TYPE || c->GetType()==SmBSplineCurve_TYPE),"identity UV unsupported trim class");
        Words w; word(w,c->GetType()); curve(w,c,2,true);
        if(c->GetType()==SmLine_TYPE) {
            auto* line=static_cast<SmLine*>(c); SmPoint3d p; SmVector3d a; double scale=0; SmExtent1d iv; SmBoolean reverse=UNSURE;
            plane_numeric::checked(line->GetCanonical(p,a,scale,iv,&reverse));
            for(unsigned d=0;d<3;++d) {real(w,p[d]); real(w,a[d]);}
            real(w,scale); real(w,iv.GetMin()); real(w,iv.GetMax()); word(w,reverse);
        }
        return w;
    }
    Words graph(bool initial) {
        Words w; SmTArray<SmFace*> faces; owned.GetFaces(faces);
        SmTArray<SmEdge*> edges; owned.GetEdges(edges); SmTArray<SmVertex*> vertices; owned.GetVertices(vertices);
        limit(faces.GetSize()>0 && faces.GetSize()<=16 && edges.GetSize()<=64 && vertices.GetSize()<=64,
            "identity UV fixed topology budget");
        word(w,faces.GetSize()); word(w,edges.GetSize()); word(w,vertices.GetSize()); real(w,owned.GetTolerance());
        SmTArray<SmTopology*> topology; owned.GetTopology(topology);
        limit(topology.GetSize()<=2048,"identity UV complete topology budget"); word(w,topology.GetSize());
        for(auto* t:topology) { check(t,"identity UV null topology inventory"); pointer(w,t); word(w,t->GetType()); }
        SmTArray<SmRegion*> regions; owned.GetRegions(regions);
        limit(regions.GetSize()<=128,"identity UV region budget"); pointer(w,owned.GetInfiniteRegion()); word(w,regions.GetSize());
        for(auto* region:regions) { check(region,"identity UV null region"); pointer(w,region); word(w,region->IsVoid()); }
        for(auto* f:faces) {
            check(f && f->GetBrep()==&owned,"identity UV foreign face"); pointer(w,f); real(w,f->GetTolerance());
            SmFaceuse *front=nullptr,*back=nullptr; f->GetFaceuses(front,back);
            for(auto* fu:{front,back}) {
                check(fu && fu->GetShell() && fu->GetShell()->GetRegion(),"identity UV missing material-side faceuse");
                pointer(w,fu); word(w,fu->GetOrientation()); pointer(w,fu->GetShell()); pointer(w,fu->GetShell()->GetRegion());
            }
            auto* s=f->GetSurface(); check(s && s->GetFace()==f && (s->GetType()==SmBSplineSurface_TYPE || (initial && s->GetType()==SmPlane_TYPE)),
                "identity UV surface class changed unexpectedly"); surface(w,static_cast<SmBSplineSurface*>(s),initial);
            const auto uv=f->GetUVDomain(); real(w,uv.GetUMin()); real(w,uv.GetUMax()); real(w,uv.GetVMin()); real(w,uv.GetVMax());
            SmTArray<SmLoop*> loops; f->GetLoops(loops); check(loops.GetSize()==1,"identity UV only one bounded outer loop");
            auto* loop=loops[0]; check(loop && loop->GetLoopuse() && loop->GetLoopuse()->GetOrientation()==SM_OT_SAME,
                "identity UV requires an actual outer loop"); pointer(w,loop); pointer(w,loop->GetLoopuse()); word(w,loop->GetLoopuse()->GetOrientation());
            SmTArray<SmEdgeuse*> uses; loop->GetEdgeuses(uses); check(uses.GetSize()==4,"identity UV needs complete four-edge face");
            for(auto* use:uses) {
                check(use && use->GetFace()==f && use->GetMate() && use->GetMate()->GetFace()==f,"identity UV foreign use/mate");
                pointer(w,use); pointer(w,use->GetMate()); pointer(w,use->GetEdge()); pointer(w,use->GetCWEdgeuse()); pointer(w,use->GetCCWEdgeuse());
                word(w,use->GetOrientation()); word(w,use->GetMate()->GetOrientation());
                pointer(w,use->GetLoopuse()); pointer(w,use->GetMate()->GetLoopuse());
                check(use->GetVertexuse() && use->GetMate()->GetVertexuse(),"identity UV missing use endpoint");
                pointer(w,use->GetVertexuse()); pointer(w,use->GetMate()->GetVertexuse());
                pointer(w,use->GetVertexuse()->GetVertex()); pointer(w,use->GetMate()->GetVertexuse()->GetVertex());
            }
        }
        for(auto* e:edges) {
            check(e && e->GetBrep()==&owned,"identity UV foreign edge"); endpoints(e); pointer(w,e); pointer(w,e->GetStartVertex()); pointer(w,e->GetEndVertex());
            pointer(w,e->GetPrimaryEdgeuse()); word(w,e->GetPrimaryEdgeuse()->GetOrientation());
            real(w,e->GetTolerance()); const auto iv=e->GetInterval(); real(w,iv.GetMin()); real(w,iv.GetMax());
            auto* c=e->GetCurve(); check(c && c->GetOwner()==e && (c->GetType()==SmBSplineCurve_TYPE || (initial && c->GetType()==SmLine_TYPE)),
                "identity UV curve class changed unexpectedly"); curve(w,static_cast<SmBSplineCurve*>(c),3,initial);
        }
        for(auto* v:vertices) { check(v,"identity UV null vertex"); pointer(w,v); const auto p=v->GetPoint();
            real(w,v->GetTolerance()); real(w,p.x); real(w,p.y); real(w,p.z); }
        return w;
    }
    bool needs_carry() {
        SmTArray<SmFace*> faces; owned.GetFaces(faces); SmTArray<SmEdge*> edges; owned.GetEdges(edges);
        if(faces.GetSize()==0 || faces.GetSize()>16 || edges.GetSize()>64) return false;
        for(auto* f:faces) if(!f || !f->GetSurface() || f->GetSurface()->GetType()!=SmPlane_TYPE) return false;
        bool gap=false;
        for(auto* e:edges) {
            auto* c=e?e->GetCurve():nullptr;
            if(!c || (c->GetType()!=SmLine_TYPE && c->GetType()!=SmBSplineCurve_TYPE)) return false;
            auto* b=static_cast<SmBSplineCurve*>(c); if(!b->GetGwNurbPointer() || b->GetDim()!=3 || b->GetDegree()!=1 || b->GetNumberNaturalKnots()!=4) return false;
            ULONG n=0; double* p=nullptr; plane_numeric::checked(b->GetControlPointsPointer(n,p)); if(n!=2) return false;
            controls(p,n,3); SmTArray<double> k; plane_numeric::checked(b->GetKnotsAll(k)); pair(k.GetDataArray(),k.GetSize());
            const auto iv=e->GetInterval(); check(std::isfinite(iv.GetMin()) && std::isfinite(iv.GetMax()) && iv.GetMin()<iv.GetMax() &&
                iv.GetMin()>=k[0] && iv.GetMax()<=k[3],"identity UV edge interval outside support");
            check(e->GetBrep()==&owned && b->GetOwner()==e,"identity UV foreign source curve"); endpoints(e);
            const auto a=e->GetStartVertex()->GetPoint(),z=e->GetEndVertex()->GetPoint();
            for(unsigned d=0;d<3;++d) gap|=!linear_value(a[d],p[d],p[4+d],k[0],k[3],iv.GetMin()) ||
                !linear_value(z[d],p[d],p[4+d],k[0],k[3],iv.GetMax());
        }
        return gap;
    }
public:
    // ONLY the raw identity matrix is eligible; every other affine is outside
    // this producer contract. No assertion from a caller activates a token.
    IdentityUvTransfer(SmBrep& checked_owned_copy,const double* matrix):owned(checked_owned_copy) {
        for(unsigned i=0;i<16;++i) if(!matrix || matrix[i]!=(i%5==0?1.:0.)) return;
        if(!needs_carry()) return;
        // Genuine existing UV authority before any representation mutation.
        const auto admission=certify_plane_domain(&owned);
        check(admission.methods==1 && !admission.rectangle_count,"identity UV needs complete existing analytic UV authority");
        before=graph(true);
        SmTArray<SmFace*> faces; owned.GetFaces(faces);
        for(auto* face:faces) {
            auto* surface=static_cast<SmBSplineSurface*>(face->GetSurface());
            ULONG ku=0,kv=0; double *u=nullptr,*v=nullptr;
            plane_numeric::checked(surface->GetKnotsPointers(ku,kv,u,v)); pair(u,ku); pair(v,kv);
            const auto face_uv=face->GetUVDomain();
            check(face_uv.GetUMin()<face_uv.GetUMax() && face_uv.GetVMin()<face_uv.GetVMax() &&
                face_uv.GetUMin()>=u[0] && face_uv.GetUMax()<=u[3] && face_uv.GetVMin()>=v[0] && face_uv.GetVMax()<=v[3],
                "identity UV actual face domain escapes supported map");
            SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
            for(auto* use:uses) {
                SmEdgeuse* owner=nullptr; auto* uv=use->GetUVTrimCurve(&owner);
                check(uv && owner && owner->GetFace()==face && uv->GetOwner()==owner,
                    "identity UV lacks actual same-face owned trim");
                check(use->GetDropCurveFail()==nullptr,"identity UV unresolved drop/fitting provenance");
                const auto signature=trim_signature(uv);
                ULONG n=0; double* p=nullptr; plane_numeric::checked(uv->GetControlPointsPointer(n,p));
                for(unsigned i=0;i<n;++i) check(p[4*i]>=u[0] && p[4*i]<=u[3] && p[4*i+1]>=v[0] && p[4*i+1]<=v[3],
                    "identity UV actual complete trim hull escapes supported map");
                for(const auto& t:trims) check(t.original!=uv,"identity UV shared trim ownership");
                trims.push_back({face,use->GetEdge(),use,use->GetMate(),uv,nullptr,signature});
            }
        }
        limit(trims.size()<=64,"identity UV trim record budget");
        // Every proof/read and C++ allocation completes BEFORE detaching. Move
        // the actual existing UV objects; do not copy through a base class,
        // fit curves, normalize coefficients or invent new authored data.
        for(auto& t:trims) {
            t.use->SetUVTrimCurve(nullptr,0,FALSE);
            check(t.use->GetUVTrimCurve()==nullptr,"identity UV detach did not clear owning mate pair");
            t.original->SetOwner(nullptr); t.curve.reset(t.original);
        }
        active=true;
    }
    IdentityUvTransfer(const IdentityUvTransfer&)=delete;
    IdentityUvTransfer& operator=(const IdentityUvTransfer&)=delete;
    bool prepared() const { return active; }
    void restore(SmBrep& actual_owned_output) {
        check(!consumed && &actual_owned_output==&owned,"identity UV token owner or one-shot lifetime mismatch"); consumed=true;
        if(!active) return;
        check(graph(false)==before,"identity UV conversion changed topology, parameters, tolerances or coefficients");
        for(auto& t:trims) {
            check(t.use->GetFace()==t.face && t.use->GetEdge()==t.edge && t.use->GetMate()==t.mate,
                "identity UV destination incarnation changed");
            check(trim_signature(t.curve.get())==t.signature,"identity UV retained trim changed");
        }
        for(auto& t:trims) {
            auto* saved=t.curve.release(); t.use->SetUVTrimCurve(saved,0,TRUE);
            SmEdgeuse* owner=nullptr;
            check(t.use->GetUVTrimCurve(&owner)==saved && owner && owner->GetFace()==t.face &&
                (owner==t.use || owner==t.mate) && saved->GetOwner()==owner,
                "identity UV canonical destination ownership failure");
        }
        const auto admission=certify_plane_domain(&owned);
        check(admission.methods==2 && !admission.rectangle_count,"identity UV restored actual rational trim admission mismatch");
        std::fprintf(stderr,"identity UV preserved exact maps and %zu genuine existing trims on owned converted output\n",trims.size());
    }
};
}
