// SPDX-License-Identifier: MPL-2.0
#include "plane_domain.hpp"
#include "plane_source_certificate.hpp"
#include "empty.hpp"
#include <SmApiQueries.h>
#include <SmAssertArray.h>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmCone.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmLoop.h>
#include <SmPlane.h>
#include <SmVertex.h>
#include <cfenv>
#include <cstdio>
namespace {
using namespace plane_numeric;
constexpr size_t budget=1000000;
void charge(PlaneDomain& domain,size_t n) {
    require(n<=budget && domain.coefficients<=budget-n,"plane coefficient budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    domain.coefficients+=static_cast<uint32_t>(n);
}
void tolerance(PlaneDomain& domain,double value) {
    require(std::isfinite(value) && value>=0,"nonfinite source tolerance");
    domain.tolerance=std::max(domain.tolerance,value);
}
void knots(const double* k,size_t count,size_t controls,ULONG degree) {
    require(k && degree>0 && degree<=64 && controls>degree && controls<=budget &&
        count==controls+degree+1,"uncertified rational knot dimensions");
    size_t multiplicity=0;
    for(size_t i=0;i<count;++i) {
        require(std::isfinite(k[i]) && (!i || k[i]>=k[i-1]),"invalid rational knots");
        multiplicity=i && k[i]==k[i-1]?multiplicity+1:1;
        require(multiplicity<=degree+1,"invalid rational knot multiplicity");
        if(i<=degree) require(k[i]==k[0],"unclamped rational start");
        if(i>=controls) require(k[i]==k[count-1],"unclamped rational end");
    }
    require(k[0]<k[count-1],"collapsed rational domain");
}
Bounds hull(const double* p,size_t count,unsigned dimensions,PlaneDomain& domain) {
    require(p && count>0,"missing rational controls"); charge(domain,count);
    Bounds box=vacant();
    for(size_t i=0;i<count;++i) {
        const double w=p[4*i+3]==NL_NOW ? 1 : p[4*i+3];
        Bounds point{};
        for(unsigned d=0;d<dimensions;++d) point[d]=quotient(p[4*i+d],w);
        include(box,point,dimensions);
    }
    return box;
}
Bounds curve_hull(SmBSplineCurve* c,unsigned dimensions,const SmExtent1d& interval,PlaneDomain& domain) {
    require(c && c->GetGwNurbPointer(),"plane domain requires existing rational trim/edge data");
    ULONG n=0; double* points=nullptr; checked(c->GetControlPointsPointer(n,points));
    require(n>0 && n<=budget,"rational curve control budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    SmTArray<double> k; checked(c->GetKnotsAll(k));
    knots(k.GetDataArray(),k.GetSize(),n,c->GetDegree());
    require(interval.GetMin()<interval.GetMax() &&
        interval.IsContainedBy(SmExtent1d(k[0],k[k.GetSize()-1])),
        "actual edge/trim parameter interval escapes clamped curve knot support");
    return hull(points,n,dimensions,domain);
}
bool rational_curve(SM_TYPE type) {
    return type==SmBSplineCurve_TYPE || type==SmLine_TYPE || type==SmCircle_TYPE || type==SmEllipse_TYPE;
}
void preflight_existing_data(SmBrep* source,const SmTArray<SmFace*>& faces,const SmTArray<SmEdge*>& edges) {
    // No Evaluate*, MakeNurb, GetOrCreate*, geometric closure or SDK validator.
    // Native handles refer to SDK-constructed topology; inspect representations
    // before any operation that may evaluate or lazily materialize geometry.
    for(auto* face:faces) {
        require(face && face->GetType()==SmFace_TYPE && face->GetSurface(),"unsupported source face");
        auto* surface=face->GetSurface(); const auto type=surface->GetType();
        require(type==SmPlane_TYPE || type==SmBSplineSurface_TYPE || type==SmCylinder_TYPE || type==SmCone_TYPE,
            "unsupported source surface representation");
        if(type==SmCone_TYPE || type==SmCylinder_TYPE) {
            // The BRep cylinder API creates a genuine SmCone with equal radii.
            // Class alone is insufficient: inspect the actual canonical angle.
            SmAxis2Placement frame; double radius=0,angle=0;
            checked(static_cast<SmCone*>(surface)->GetCanonical(frame,radius,angle));
            require(angle==0 && std::isfinite(radius) && radius>0,
                "method4 requires an exactly zero-angle positive-radius cone/cylinder");
        }
        require(static_cast<SmBSplineSurface*>(surface)->GetGwNurbPointer(),"unmaterialized source surface");
        if(type==SmCylinder_TYPE || type==SmCone_TYPE) {
            auto* generator=static_cast<SmCone*>(surface)->GetGenCurve();
            require(generator && rational_curve(generator->GetType()) && generator->GetGwNurbPointer(),
                "unknown or unmaterialized cylinder generator");
        }
    }
    for(auto* edge:edges) {
        require(edge && edge->GetType()==SmEdge_TYPE && edge->GetCurve() && rational_curve(edge->GetCurve()->GetType()),
            "unsupported source edge representation");
        require(static_cast<SmBSplineCurve*>(edge->GetCurve())->GetGwNurbPointer(),"unmaterialized source edge");
    }
    SmTArray<SmEdgeuse*> uses; source->GetEdgeuses(uses);
    require(uses.GetSize()<=400000,"source edgeuse preflight budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    for(auto* use:uses) {
        require(use && use->GetEdge() && use->GetFace(),"unsupported source edgeuse");
        auto* trim=use->GetUVTrimCurve(); // Read only, including an existing mate trim.
        if(trim) require(rational_curve(trim->GetType()) && trim->GetGwNurbPointer(),
            "unknown or present-but-unmaterialized source UV trim");
    }
}
Bounds trim_domain(SmFace* face,PlaneDomain& domain) {
    SmTArray<SmLoop*> loops; face->GetLoops(loops);
    require(loops.GetSize()>0 && loops.GetSize()<=8192,"missing or oversized finite face loops");
    Bounds uv=vacant();
    for(auto* loop:loops) {
        require(loop && loop->IsClosedPtrs(),"open source trim pointer loop");
        SmTArray<SmEdgeuse*> uses; loop->GetEdgeuses(uses);
        require(uses.GetSize()>0 && uses.GetSize()<=8192,"missing or oversized trim cycle");
        for(auto* use:uses) {
            require(use && use->GetFace()==face,"foreign source trim");
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            const bool owned=owner && owner->GetFace()==face;
            const bool supported=trim && rational_curve(trim->GetType());
            if(!owned || !supported) {
                // Read existing representation metadata only; never create or
                // evaluate a missing trim to make this admission succeed.
                std::fprintf(stderr,"plane trim refusal face_type=%ld surface_type=%ld has_owner=%d same_face=%d has_trim=%d trim_type=%ld materialized=%d\n",
                    static_cast<long>(face->GetType()),static_cast<long>(face->GetSurface()->GetType()),
                    owner!=nullptr,owned,trim!=nullptr,trim?static_cast<long>(trim->GetType()):-1L,
                    supported && trim->GetGwNurbPointer()!=nullptr);
            }
            require(owned && supported,"missing or uncertified existing UV trim");
            include(uv,curve_hull(trim,2,use->GetEdge()->GetInterval(),domain),2);
        }
    }
    // Every curve of the bounded outer loop lies in this convex UV rectangle.
    // Its bounded interior (and any holes removed from it) lies there too.
    return uv;
}
Bounds cylinder_hull(SmCone* c,SmFace* face,uint32_t index,PlaneDomain& domain) {
    require(c->GetType()==SmCone_TYPE || c->GetType()==SmCylinder_TYPE,"unknown cylindrical surface dispatch");
    require(c->GetGwNurbPointer() && c->GetGenCurve() && c->GetGenCurve()->GetGwNurbPointer() &&
        c->IsBounded() && c->IsOutOfBoundsEnabled()==FALSE,"cylinder is not a finite clamped analytic surface");
    require(domain.cylinder_count<IFCLITE_SMLIB_PLANE_MAX_CYLINDERS,"cylinder certificate record budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    SmAxis2Placement frame; double radius=0,angle=0; SmBoolean swap=UNSURE,inside=UNSURE;
    checked(c->SmCone::GetCanonical(frame,radius,angle,&swap,&inside));
    require(angle==0 && std::isfinite(radius) && radius>0 &&
        (swap==TRUE || swap==FALSE) && (inside==TRUE || inside==FALSE),"unknown cylinder canonical dispatch");
    const auto step=c->GetSTEPUVDomain();
    const double v0=step.GetVMin(),v1=step.GetVMax();
    require(std::isfinite(v0) && std::isfinite(v1) && v0<v1 &&
        std::isfinite(step.GetUMin()) && std::isfinite(step.GetUMax()) && step.GetUMin()<step.GetUMax(),
        "invalid finite cylinder STEP domain");
    const auto natural=c->GetNaturalUVDomain();
    require(natural.GetUMin()<natural.GetUMax() && natural.GetVMin()<natural.GetVMax() &&
        std::isfinite(natural.GetUMin()) && std::isfinite(natural.GetUMax()) &&
        std::isfinite(natural.GetVMin()) && std::isfinite(natural.GetVMax()),"invalid cylinder UV conversion domain");
    const auto face_uv=face->GetUVDomain();
    require(face_uv.GetUMin()<face_uv.GetUMax() && face_uv.GetVMin()<face_uv.GetVMax() &&
        face_uv.IsContainedBy(natural),"actual cylinder face UV domain escapes supported conversion domain");
    const auto origin=frame.GetOrigin();
    const SmVector3d axes[]={frame.GetXAxis(),frame.GetYAxis(),frame.GetZAxis()};
    auto& record=domain.cylinders[domain.cylinder_count++];
    record.source_face=index; record.swap_uv=swap; record.inside_out=inside;
    record.radius=radius; record.step_v[0]=v0; record.step_v[1]=v1;
    Bounds result{};
    for(unsigned d=0;d<3;++d) {
        require(std::isfinite(origin[d]),"nonfinite cylinder origin"); record.origin[d]=origin[d];
        for(unsigned j=0;j<3;++j) {
            require(std::isfinite(axes[j][d]),"nonfinite cylinder basis"); record.basis[3*j+d]=axes[j][d];
        }
        // SmCone::EvaluatePoint -> ConvertUVFromNURBSToSTEP -> EvaluateSTEP.
        // The latter clamps BOTH coordinates to this STEP domain. With angle
        // exactly zero its entire image is O+R*cos(U)X+R*sin(U)Y+V*Z.
        // These are raw actual coefficients; no unit-basis assumption.
        result[d]=exact(origin[d])+Interval{-radius,radius}*exact(axes[0][d])+
            Interval{-radius,radius}*exact(axes[1][d])+Interval{v0,v1}*exact(axes[2][d]);
    }
    domain.methods|=4; return result;
}
plane_source_proof::Rectangle rectangle_domain(SmFace* face,uint32_t index,PlaneDomain& domain) {
    auto proof=plane_source_proof::certify_axis_rectangle(face); proof.source_face=index;
    charge(domain,proof.control_count); // 4 patch + 4*2 complete boundary controls
    SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
    require(uses.GetSize()==4,"affine upward boundary inventory mismatch");
    for(auto* use:uses) if(auto* trim=use->GetUVTrimCurve()) {
        // Same operation ledger as surface/boundary/global edges, never reset.
        const auto uv=curve_hull(trim,2,use->GetEdge()->GetInterval(),domain);
        require(uv[0].lo>=proof.u[0] && uv[0].hi<=proof.u[3] &&
            uv[1].lo>=proof.v[0] && uv[1].hi<=proof.v[3],"present affine UV hull escapes knot support");
    }
    return proof;
}
bool missing_cached_uv(SmFace* face) {
    SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
    require(uses.GetSize()>0 && uses.GetSize()<=400000,"missing or oversized source boundary");
    for(auto* use:uses) {
        require(use && use->GetFace()==face,"foreign source boundary use");
        if(!use->GetUVTrimCurve()) return true;
    }
    return false;
}
Bounds face_hull(SmFace* face,uint32_t index,PlaneDomain& domain) {
    require(face && face->GetType()==SmFace_TYPE && face->GetSurface(),"unsupported source face");
    auto* surface=face->GetSurface();
    if(surface->GetType()==SmCylinder_TYPE || surface->GetType()==SmCone_TYPE)
        return cylinder_hull(static_cast<SmCone*>(surface),face,index,domain);
    if(surface->GetType()==SmBSplineSurface_TYPE && missing_cached_uv(face)) {
        require(domain.rectangle_count<IFCLITE_SMLIB_PLANE_MAX_RECTANGLES,
            "source rectangle certificate record budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
        const auto proof=rectangle_domain(face,index,domain);
        domain.rectangles[domain.rectangle_count++]=plane_source_proof::certificate_record(proof);
        domain.methods|=IFCLITE_SMLIB_PLANE_SOURCE_RECTANGLE; return proof.bounds;
    }
    auto uv=trim_domain(face,domain);
    if(surface->GetType()==SmPlane_TYPE) {
        // Plane UVs use the analytic STEP map, not a sampled boundary or an
        // assumed equivalence with an unbounded plane's NURBS rectangle.
        const auto* plane=static_cast<const SmPlane*>(surface);
        const auto& frame=plane->GetPosition(); const auto scale=plane->GetUVScale();
        const auto origin=frame.GetOrigin(),x=frame.GetXAxis(),y=frame.GetYAxis();
        Bounds result{};
        for(unsigned d=0;d<3;++d) result[d]=exact(origin[d])+
            (uv[0]*exact(scale.x))*exact(x[d])+(uv[1]*exact(scale.y))*exact(y[d]);
        domain.methods|=1; return result;
    }
    // Deliberately exclude specialized analytic evaluators until equivalence
    // with their materialized rational patch and parameter map is qualified.
    require(surface->GetType()==SmBSplineSurface_TYPE,"plane domain surface class needs an analytic enclosure proof");
    auto* b=static_cast<SmBSplineSurface*>(surface);
    require(b->GetGwNurbPointer(),"plane domain requires materialized rational surface");
    require(b->GetBSplineSurfaceForm()!=SM_SF_POLYNOMIAL && b->IsOutOfBoundsEnabled()==FALSE,
        "power-basis or extrapolating generic surface needs a separate enclosure proof");
    ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
    checked(b->GetControlPointsPointer(nu,nv,p)); checked(b->GetKnotsPointers(ku,kv,u,v));
    require(nu && nv && nu<=budget/nv,"oversized surface control net",IFCLITE_SMLIB_RESOURCE_LIMIT);
    knots(u,ku,nu,b->GetDegree(SM_SP_U)); knots(v,kv,nv,b->GetDegree(SM_SP_V));
    const auto face_uv=face->GetUVDomain();
    require(face_uv.GetUMin()<face_uv.GetUMax() && face_uv.GetVMin()<face_uv.GetVMax() &&
        face_uv.IsContainedBy(SmExtent2d(u[0],v[0],u[ku-1],v[kv-1])),
        "actual generic face UV domain escapes clamped surface domain");
    require(uv[0].lo>=u[0] && uv[0].hi<=u[ku-1] && uv[1].lo>=v[0] && uv[1].hi<=v[kv-1],
        "actual UV trim hull escapes rational surface parameter domain");
    // Positive weights + clamped knots: nonnegative partition of unity on the
    // entire patch. The full control hull covers face INTERIORS, not just edges.
    domain.methods|=2; return hull(p,size_t(nu)*nv,3,domain);
}
}
namespace {
void validate_topology(SmBrep* solid,const char* stage) {
    using namespace plane_numeric;
    require(solid && solid->GetInfiniteRegion() && solid->GetInfiniteRegion()->IsVoid()==TRUE,
        "plane operand/result has an unbounded material region",IFCLITE_SMLIB_UNSUPPORTED);
    // ValidatePointers may return SUCCESS while recording failed checks.
    // Its status AND its actual report collection must both be accepted.
    SmAssertArray reports;
    const auto status=solid->ValidatePointers(&reports,SM_LEVEL_2);
    if(status!=SM_SUCCESS || reports.GetSize()!=0) {
        // Read report scalars only: do not dereference suspect owners, evaluate
        // geometry again, heal, or suppress any failure. Bound diagnostic size.
        std::fprintf(stderr,"plane validation stage=%s status=%ld reports=%lu brep_tol=%.17g\n",
            stage,static_cast<long>(status),static_cast<unsigned long>(reports.GetSize()),solid->GetTolerance().val);
        for(ULONG i=0;i<reports.GetSize() && i<16;++i) {
            const auto* r=reports[i];
            if(!r) { std::fprintf(stderr,"plane report[%lu] null\n",static_cast<unsigned long>(i)); continue; }
            std::fprintf(stderr,"plane report[%lu] reporter=%ld list=%lu test=%lu owner_type=%ld other_type=%ld value=%.17g tol=%.17g\n",
                static_cast<unsigned long>(i),r->m_lReportingType,
                static_cast<unsigned long>(r->GetListIndex()),static_cast<unsigned long>(r->GetTestIndex()),
                static_cast<long>(r->GetOwnerType()),static_cast<long>(r->GetOtherType()),r->GetValue(),r->GetTol3d().val);
        }
    }
    checked(status);
    require(reports.GetSize()==0,"plane topology pointer validation reported failures",IFCLITE_SMLIB_KERNEL_ERROR);
    if(semantically_empty_brep(solid)) return;
    SmBoolean manifold=FALSE; checked(SmApiBrepIsManifoldSolid(solid,manifold));
    SmTArray<SmFace*> faces; solid->GetFaces(faces);
    require(manifold && faces.GetSize()>0,"plane operand/result is not a closed manifold solid",IFCLITE_SMLIB_KERNEL_ERROR);
}
}
void validate_plane_solid(SmBrep* solid,const char* stage) {
    using namespace plane_numeric;
    validate_topology(solid,stage);
    if(semantically_empty_brep(solid)) return;
    // Preserve the previous geometric loop-closure oracle, but evaluate it
    // only here on owned copied/cutter/output geometry, never on the source.
    SmTArray<SmFace*> faces; solid->GetFaces(faces);
    for(auto* face:faces) {
        SmTArray<SmLoop*> loops; face->GetLoops(loops);
        for(auto* loop:loops) require(loop && loop->IsClosedPtrs() && loop->IsClosed3d(),
            "owned numerical solid has an open geometric trim loop",IFCLITE_SMLIB_KERNEL_ERROR);
    }
    double volume=0; checked(SmApiBrepComputeVolume(solid,1e-8,volume));
    require(std::isfinite(volume) && volume>0,"plane operand/result lacks positive finite material volume",IFCLITE_SMLIB_KERNEL_ERROR);
}
PlaneDomain certify_plane_domain(SmBrep* source) {
    using namespace plane_numeric;
    require(std::numeric_limits<double>::is_iec559 && std::fegetround()==FE_TONEAREST,
        "plane enclosure requires IEEE binary64 round-to-nearest");
    volatile double minimum=std::numeric_limits<double>::min(),half=0.5;
    volatile double subnormal=minimum*half;
    require(subnormal>0,"plane enclosure requires gradual underflow");
    // ValidatePointers is evaluating even at LEVEL_0. It must not run on the
    // source: an existing trim without NURBS can crash or lazily mutate it.
    require(source && source->GetInfiniteRegion() && source->GetInfiniteRegion()->IsVoid()==TRUE,
        "source lacks a finite-material topology domain");
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    SmTArray<SmEdge*> edges; source->GetEdges(edges);
    SmTArray<SmVertex*> vertices; source->GetVertices(vertices);
    require(faces.GetSize()<=100000 && edges.GetSize()<=100000 && vertices.GetSize()<=100000,
        "plane topology budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    preflight_existing_data(source,faces,edges);
    PlaneDomain domain; domain.empty=semantically_empty_brep(source);
    if(domain.empty) { domain.bounds={{{0,0},{0,0},{0,0}}}; return domain; }
    // IsManifoldSolid only inspects regions, shell vertices and edgeuse types
    // in this SDK (SmBrep11246, SmEdge4722); it never evaluates geometry.
    require(source->IsManifoldSolid() && faces.GetSize()>0,"source is not a manifold solid topology");
    tolerance(domain,source->GetTolerance());
    domain.faces=faces.GetSize(); domain.edges=edges.GetSize();
    for(ULONG i=0;i<faces.GetSize();++i) {
        auto* f=faces[i]; require(f && f->GetBrep()==source,"missing or foreign source face");
        tolerance(domain,f->GetTolerance()); include(domain.bounds,face_hull(f,i,domain));
    }
    for(auto* e:edges) {
        require(e && e->GetType()==SmEdge_TYPE && e->GetCurve() && rational_curve(e->GetCurve()->GetType()),
            "unsupported source edge");
        auto* c=static_cast<SmBSplineCurve*>(e->GetCurve());
        require(c->GetGwNurbPointer(),"unmaterialized source edge");
        require(e->GetInterval().IsContainedBy(c->GetNaturalInterval()),"edge outside rational domain");
        tolerance(domain,e->GetTolerance()); include(domain.bounds,curve_hull(c,3,e->GetInterval(),domain));
    }
    for(auto* v:vertices) {
        require(v,"missing source vertex"); tolerance(domain,v->GetTolerance());
        const auto p=v->GetPoint(); include(domain.bounds,{{exact(p.x),exact(p.y),exact(p.z)}});
    }
    domain.bounds=expanded(domain.bounds,domain.tolerance);
    for(auto a:domain.bounds) require(std::isfinite(a.lo) && std::isfinite(a.hi) && a.lo<a.hi,
        "nonfinite or collapsed finite BRep domain");
    return domain;
}

plane_source_proof::Rectangle certify_plane_source_rectangle(SmBrep* source,SmFace* face) {
    using namespace plane_numeric;
    require(source && source->GetInfiniteRegion() && source->GetInfiniteRegion()->IsVoid()==TRUE,
        "affine source lacks finite-material topology");
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    SmTArray<SmEdge*> edges; source->GetEdges(edges);
    SmTArray<SmVertex*> vertices; source->GetVertices(vertices);
    require(faces.GetSize()<=100000 && edges.GetSize()<=100000 && vertices.GetSize()<=100000,
        "affine source topology budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
    preflight_existing_data(source,faces,edges);
    require(source->IsManifoldSolid() && face,"affine source face topology");
    for(ULONG i=0;i<faces.GetSize();++i) if(faces[i]==face) {
        require(face->GetBrep()==source,"affine source face ownership");
        PlaneDomain ledger; return rectangle_domain(face,i,ledger);
    }
    throw SweepFailure{IFCLITE_SMLIB_UNSUPPORTED,"affine face is absent from actual source inventory"};
}

void populate_plane_source_records(const PlaneDomain& domain,ifclite_smlib_plane_certificate& c) {
    using namespace plane_numeric;
    require(domain.rectangle_count<=IFCLITE_SMLIB_PLANE_MAX_RECTANGLES &&
        ((domain.methods&IFCLITE_SMLIB_PLANE_SOURCE_RECTANGLE)!=0)==(domain.rectangle_count!=0),
        "inconsistent derived source proof records",IFCLITE_SMLIB_KERNEL_ERROR);
    c.version=domain.rectangle_count?2u:1u; c.method=domain.methods;
    c.rectangle_count=domain.rectangle_count;
    c.rectangle_record_bytes=domain.rectangle_count?IFCLITE_SMLIB_PLANE_RECTANGLE_BYTES:0;
    c.rectangle_edge_bytes=domain.rectangle_count?IFCLITE_SMLIB_PLANE_RECTANGLE_EDGE_BYTES:0;
    c.rectangle_reserved=0;
    std::fill(std::begin(c.rectangles),std::end(c.rectangles),ifclite_smlib_rectangle_domain{});
    std::copy_n(domain.rectangles.begin(),domain.rectangle_count,c.rectangles);
}
