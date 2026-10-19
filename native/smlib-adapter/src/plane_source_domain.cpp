// SPDX-License-Identifier: MPL-2.0
#include "plane_source_domain.hpp"
#include "plane_dyadic.hpp"
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFaceuse.h>
#include <SmLine.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
#include <cstdio>
namespace plane_source_proof {
namespace {
using namespace plane_numeric;
void clamped_pair(const double* k,size_t n) {
    require(k && n==4 && std::isfinite(k[0]) && std::isfinite(k[3]) &&
        k[0]==k[1] && k[2]==k[3] && k[0]<k[3],"affine proof requires degree1 clamped knot pair");
}
void unit_controls(const double* p,unsigned n) {
    require(p,"absent affine controls");
    for(unsigned i=0;i<n;++i) {
        require(p[4*i+3]==NL_NOW || p[4*i+3]==1,"affine proof requires unit positive weights");
        for(unsigned d=0;d<3;++d) require(std::isfinite(p[4*i+d]),"nonfinite affine control");
    }
}
std::array<double,3> point(SmVertex* v) {
    require(v,"missing affine boundary vertex"); const auto p=v->GetPoint();
    require(std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z),"nonfinite affine boundary vertex");
    return {p.x,p.y,p.z};
}
bool supported_trim(SmBSplineCurve* c) {
    if(!c) return true;
    const auto t=c->GetType();
    return (t==SmBSplineCurve_TYPE || t==SmLine_TYPE || t==SmCircle_TYPE || t==SmEllipse_TYPE) && c->GetGwNurbPointer();
}
void analytic_line(SmLine* line,EdgeRecord& r) {
    SmPoint3d origin; SmVector3d axis; SmExtent1d step; SmBoolean inside=UNSURE;
    checked(line->GetCanonical(origin,axis,r.scale,step,&inside));
    require((inside==TRUE || inside==FALSE) && line->IsBounded() &&
        std::isfinite(r.scale) && r.scale>0 && std::isfinite(step.GetMin()) &&
        std::isfinite(step.GetMax()) && step.GetMin()<step.GetMax(),"unsupported canonical boundary line");
    // ConvertTFromNURBSToSTEP has a special near-zero-length branch.
    // Refuse that branch; this is dispatch authentication, never zero proof.
    const double length=r.knots[3]-r.knots[0];
    require(std::isfinite(length) && !SM_IS_ZERO(length),"canonical line degenerate conversion branch");
    r.analytic=true; r.inside_out=inside==TRUE;
    r.step={step.GetMin(),step.GetMax()};
    unsigned varying=0;
    for(unsigned d=0;d<3;++d) {
        r.line_origin[d]=origin[d]; r.line_axis[d]=axis[d];
        require(std::isfinite(origin[d]) && (axis[d]==0 || axis[d]==1 || axis[d]==-1),
            "canonical boundary line requires exact coordinate axis");
        varying+=axis[d]!=0;
        // Two affine maps agreeing at both knots agree everywhere. Check the
        // actual analytic fields, including reversed STEP parameterization.
        require(canonical_value(r.controls[d],origin[d],r.scale,axis[d],r.step[r.inside_out?1:0]) &&
            canonical_value(r.controls[4+d],origin[d],r.scale,axis[d],r.step[r.inside_out?0:1]),
            "canonical line and materialized hull are not exactly equivalent");
    }
    require(varying==1,"noninjective canonical boundary line");
}
EdgeRecord edge_record(SmEdgeuse* use,unsigned edge_ordinal) {
    auto* e=use->GetEdge(); auto* curve=e->GetCurve();
    require(curve && (curve->GetType()==SmBSplineCurve_TYPE || curve->GetType()==SmLine_TYPE),
        "affine boundary requires a generic linear patch or canonical line");
    auto* c=static_cast<SmBSplineCurve*>(curve);
    require(c->GetGwNurbPointer() && c->GetDegree()==1 && c->GetDim()==3,
        "affine boundary requires existing degree1 3D data");
    ULONG n=0; double* p=nullptr; checked(c->GetControlPointsPointer(n,p));
    require(n==2,"affine boundary requires two controls"); unit_controls(p,2);
    require(c->GetNumberNaturalKnots()==4,"affine boundary knot budget");
    SmTArray<double> k; checked(c->GetKnotsAll(k)); clamped_pair(k.GetDataArray(),k.GetSize());
    const auto interval=e->GetInterval();
    require(std::isfinite(interval.GetMin()) && std::isfinite(interval.GetMax()) &&
        interval.GetMin()<interval.GetMax() && interval.GetMin()>=k[0] && interval.GetMax()<=k[3],
        "affine boundary interval outside complete clamped support");
    EdgeRecord r; std::copy_n(p,8,r.controls.begin()); std::copy_n(k.GetDataArray(),4,r.knots.begin());
    r.interval={interval.GetMin(),interval.GetMax()};
    // SDK primary edgeuse convention identifies exact interval endpoints.
    auto* primary=e->GetPrimaryEdgeuse();
    require(primary && primary->GetMate() && primary->GetMate()->GetMate()==primary &&
        primary->GetVertexuse() && primary->GetMate()->GetVertexuse() &&
        (primary->GetOrientation()==SM_OT_SAME || primary->GetOrientation()==SM_OT_OPPOSITE),
        "missing canonical edge endpoint topology");
    r.start=point(e->GetStartVertex()); r.end=point(e->GetEndVertex());
    require(r.start!=r.end,"collapsed affine boundary edge");
    for(unsigned d=0;d<3;++d) {
        const bool start_exact=linear_value(r.start[d],p[d],p[4+d],k[0],k[3],r.interval[0]);
        const bool end_exact=linear_value(r.end[d],p[d],p[4+d],k[0],k[3],r.interval[1]);
        if(!start_exact || !end_exact) {
            // Diagnostic of the same exact predicate, not an alternate proof.
            // All arrays already passed finite/materialized/size checks. No
            // SDK evaluation, source edits, fitting or tolerance substitution.
            std::fprintf(stderr,"affine endpoint refusal edge_ordinal=%u curve_type=%ld primary_orientation=%ld use_orientation=%ld dimension=%u start_exact=%d end_exact=%d\n",
                edge_ordinal,static_cast<long>(curve->GetType()),static_cast<long>(primary->GetOrientation()),
                static_cast<long>(use->GetOrientation()),d,start_exact,end_exact);
            std::fprintf(stderr,"affine endpoint controls=(%.17g %.17g %.17g %.17g) (%.17g %.17g %.17g %.17g)\n",
                p[0],p[1],p[2],p[3],p[4],p[5],p[6],p[7]);
            std::fprintf(stderr,"affine endpoint knots=(%.17g %.17g %.17g %.17g) interval=(%.17g %.17g) start=(%.17g %.17g %.17g) end=(%.17g %.17g %.17g)\n",
                k[0],k[1],k[2],k[3],r.interval[0],r.interval[1],r.start[0],r.start[1],r.start[2],r.end[0],r.end[1],r.end[2]);
        }
        require(start_exact && end_exact,"edge interval endpoints do not exactly equal topology vertices");
    }
    if(curve->GetType()==SmLine_TYPE) analytic_line(static_cast<SmLine*>(curve),r);
    return r;
}
}
Rectangle certify_axis_rectangle(SmFace* face) {
    using namespace plane_numeric;
    require(std::numeric_limits<double>::is_iec559,"affine proof requires IEEE binary64");
    require(face && face->GetType()==SmFace_TYPE && face->GetBrep() && face->GetSurface() &&
        face->GetSurface()->GetType()==SmBSplineSurface_TYPE,"affine proof requires an owned generic surface");
    auto* b=static_cast<SmBSplineSurface*>(face->GetSurface());
    require(b->GetGwNurbPointer(),"unmaterialized affine source surface");
    require(b->GetBSplineSurfaceForm()!=SM_SF_POLYNOMIAL && b->IsOutOfBoundsEnabled()==FALSE &&
        b->GetDegree(SM_SP_U)==1 && b->GetDegree(SM_SP_V)==1,"unsupported affine surface dispatch");
    SmTArray<SmLoop*> loops; face->GetLoops(loops);
    require(loops.GetSize()==1 && loops[0] && loops[0]->GetLoopuse() &&
        loops[0]->GetFace()==face && loops[0]->GetLoopuse()->GetOrientation()==SM_OT_SAME,
        "affine proof requires one outer loop and no holes");
    auto* loop=loops[0]; auto* lu=loop->GetLoopuse();
    require(lu->GetFaceuse() && lu->GetFaceuse()->GetOrientation()==SM_OT_SAME,
        "affine proof requires upward faceuse traversal");
    SmTArray<SmEdgeuse*> uses; loop->GetEdgeuses(uses);
    require(uses.GetSize()==4,"affine proof requires exactly four complete edgeuses");
    // Preflight ALL present local trims and edge representations before any
    // coefficient getter (the SDK getters can otherwise lazily materialize).
    for(auto* use:uses) {
        require(use && use->GetFace()==face && use->GetLoopuse()==lu && use->GetEdge() &&
            use->GetEdge()->GetBrep()==face->GetBrep(),"foreign affine boundary owner");
        SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
        require(supported_trim(trim) && (!trim || (owner && owner->GetFace()==face)),
            "unknown, foreign or unmaterialized existing affine trim");
        require(supported_trim(use->GetUVTrimCurvePointer()) && use->GetMate() &&
            use->GetMate()->GetFace()==face && supported_trim(use->GetMate()->GetUVTrimCurvePointer()),
            "affine mate ownership or present unmaterialized trim");
        auto* curve=use->GetEdge()->GetCurve();
        require(curve && (curve->GetType()==SmBSplineCurve_TYPE || curve->GetType()==SmLine_TYPE) &&
            static_cast<SmBSplineCurve*>(curve)->GetGwNurbPointer(),"unknown or unmaterialized affine boundary");
    }
    ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
    checked(b->GetControlPointsPointer(nu,nv,p)); checked(b->GetKnotsPointers(ku,kv,u,v));
    require(nu==2 && nv==2,"affine proof requires 2x2 surface net"); unit_controls(p,4);
    clamped_pair(u,ku); clamped_pair(v,kv);
    Rectangle r; std::copy_n(p,16,r.controls.begin()); std::copy_n(u,4,r.u.begin()); std::copy_n(v,4,r.v.begin());
    for(unsigned d=0;d<3;++d) {
        const bool du=p[d]!=p[8+d],dv=p[d]!=p[4+d];
        require(!(du && dv),"affine coordinate directions must be independent axes");
        if(du) { require(r.u_axis==3,"nonaxis U map"); r.u_axis=d; }
        if(dv) { require(r.v_axis==3,"nonaxis V map"); r.v_axis=d; }
        if(!du && !dv) { require(p[d]==p[12+d],"warped affine patch"); r.normal_axis=d; }
        else require(du?(p[d]==p[4+d] && p[8+d]==p[12+d]):
            (p[d]==p[8+d] && p[4+d]==p[12+d]),"near-affine or warped coefficient net");
        r.bounds[d]={std::min(p[d],p[12+d]),std::max(p[d],p[12+d])};
    }
    require(r.u_axis<3 && r.v_axis<3 && r.normal_axis<3,"noninjective affine map");
    r.uv_hull={Interval{u[0],u[3]},Interval{v[0],v[3]}};
    // Complete edge-control hulls lie in the same plane and supported patch.
    std::array<std::array<double,3>,4> starts{},ends{};
    for(unsigned i=0;i<4;++i) {
        r.edges[i]=edge_record(uses[i],i); auto& e=r.edges[i];
        for(unsigned j=0;j<2;++j) for(unsigned d=0;d<3;++d)
            require(e.controls[4*j+d]>=r.bounds[d].lo && e.controls[4*j+d]<=r.bounds[d].hi,
                "full boundary hull escapes exact patch plane or support");
        require(uses[i]->GetOrientation()==SM_OT_SAME || uses[i]->GetOrientation()==SM_OT_OPPOSITE,
            "unknown affine edgeuse direction");
        starts[i]=uses[i]->GetOrientation()==SM_OT_SAME?e.start:e.end;
        ends[i]=uses[i]->GetOrientation()==SM_OT_SAME?e.end:e.start;
        for(unsigned j=0;j<i;++j) require(uses[i]!=uses[j] && uses[i]->GetEdge()!=uses[j]->GetEdge(),
            "duplicate affine boundary edge");
    }
    // Recover rectangle corners from actual vertices, not face UV metadata.
    Bounds boundary=vacant(); for(const auto& q:starts) include(boundary,{{exact(q[0]),exact(q[1]),exact(q[2])}});
    require(boundary[r.u_axis].lo<boundary[r.u_axis].hi && boundary[r.v_axis].lo<boundary[r.v_axis].hi,
        "collapsed rectangular interior");
    const auto corner=[&](const std::array<double,3>& q) {
        unsigned code=0;
        for(unsigned a=0;a<2;++a) {
            const unsigned d=a==0?r.u_axis:r.v_axis;
            require(q[d]==boundary[d].lo || q[d]==boundary[d].hi,"nonrectangular boundary vertex");
            const bool forward=p[(a==0?8:4)+d]>p[d];
            code|=unsigned(forward?q[d]==boundary[d].hi:q[d]==boundary[d].lo)<<a;
        }
        require(q[r.normal_axis]==p[r.normal_axis],"boundary vertex off exact plane");
        return code;
    };
    constexpr unsigned next[]={1,3,0,2}; // parameter CCW: 00 -> 10 -> 11 -> 01
    unsigned seen=0;
    for(unsigned i=0;i<4;++i) {
        r.start_corner[i]=corner(starts[i]); r.end_corner[i]=corner(ends[i]);
        require(next[r.start_corner[i]]==r.end_corner[i] && !(seen&(1u<<r.start_corner[i])),
            "boundary is not a simple positive parameter rectangle");
        seen|=1u<<r.start_corner[i];
        unsigned successor=4;
        for(unsigned j=0;j<4;++j) if(uses[i]->GetCCWEdgeuse()==uses[j]) successor=j;
        require(successor<4 && uses[successor]->GetCWEdgeuse()==uses[i] && ends[i]==starts[successor],
            "incomplete or geometrically open rectangular boundary cycle");
        // A side's whole straight curve lies on its endpoint side; no diagonal.
        for(unsigned d=0;d<3;++d) if(starts[i][d]==ends[i][d])
            require(r.edges[i].controls[d]==starts[i][d] && r.edges[i].controls[4+d]==starts[i][d],
                "edge-control hull leaves rectangular boundary side");
    }
    require(seen==15,"incomplete rectangular boundary coverage");
    return r;
}
}
