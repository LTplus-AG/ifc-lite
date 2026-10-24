// SPDX-License-Identifier: MPL-2.0
#include "representation_seal.hpp"
#include "edge_subdivision.hpp"
#include "affine_transition.hpp"
#include "copy.hpp"
#include "context_metadata.hpp"
#include <SmApiQueries.h>
#include <SmFace.h>
#include <SmEdgeuse.h>
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <algorithm>
#include <cmath>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmLine.h>
#include <SmPlane.h>
#include <SmCone.h>
namespace face_lineage {
namespace {
void require(bool ok,const char* message) { if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,message}; }
void checked(SmStatus status) { require(status==SM_SUCCESS,"actual SDK seal getter failed"); }
constexpr ULONG coefficients=65536;
// Legal protected-member pointers, as in context_metadata.hpp; no derived
// instance or downcast to a type the SDK did not construct.
struct RevolutionAccess:SmSurfOfRevolution {
    static SmBoolean bounded_generator(const SmSurfOfRevolution& s) { return s.*(&RevolutionAccess::m_bMakeNurbGenCurve); }
    static SmBoolean planar_generator(const SmSurfOfRevolution& s) { return s.*(&RevolutionAccess::m_bPlanarGenerator); }
};
}
void RepresentationSeal::curve(SmObject* object) {
    require(object->GetType()==SmBSplineCurve_TYPE || object->GetType()==SmLine_TYPE,"curve evaluator class is not supported by exact seal");
    auto* c=static_cast<SmBSplineCurve*>(object);
    require(!c->HasAttributes() && c->GetGwNurbPointer() && !c->IsNurbBorrowed(),"missing, borrowed or attributed curve data in seal");
    pointer(c->GetOwner()); word(c->GetDim()); word(c->GetDegree()); word(c->IsOutOfBoundsEnabled()); word(c->GetInsideOut());
    const auto domain=c->GetNaturalInterval(); real(domain.GetMin()); real(domain.GetMax());
    ULONG n=0; double* control=nullptr; checked(c->GetControlPointsPointer(n,control));
    require(n && n<=coefficients/4 && control,"unsupported curve control budget"); word(n);
    for(ULONG i=0;i<4*n;++i) real(affine_slots?affine_slots->control(object,i,control[i]):control[i]); // Includes exact homogeneous weights/NL_NOW sentinel.
    const ULONG knots=c->GetNumberNaturalKnots();
    require(knots && knots<=coefficients && knots==n+c->GetDegree()+1,"invalid curve knot support"); word(knots);
    // Fixed local scratch, no expanding SDK array or lazy MakeNurb operation.
    std::array<double,coefficients> values{}; checked(c->GetKnotsExpert(0,knots-1,values.data()));
    for(ULONG i=0;i<knots;++i) real(values[i]);
    ULONG dimension=0,degree=0; SmBSplineCurveForm form; SmKnotType knot_type;
    SmTArray<SmPoint3d> points; SmTArray<ULONG> multiplicities; SmTArray<double> unique,weights;
    // The actual basis already exists and counts were bounded above. This
    // getter copies metadata; it does not authorize lazy representation changes.
    checked(c->GetCanonical(dimension,degree,points,form,multiplicities,unique,knot_type,weights));
    require(points.GetSize()==n && unique.GetSize()<=knots && multiplicities.GetSize()==unique.GetSize() &&
        (weights.GetSize()==0 || weights.GetSize()==n),"curve canonical metadata does not cover actual support");
    word(dimension); word(degree); word(form); word(knot_type);
    if(object->GetType()==SmLine_TYPE) {
        auto* line=static_cast<SmLine*>(object); const auto p=line->GetLinePoint(),v=line->GetLineVector(); const auto step=line->GetSTEPInterval();
        real(p.x); real(p.y); real(p.z); real(v.x); real(v.y); real(v.z); real(line->GetLineScale()); real(step.GetMin()); real(step.GetMax());
    }
}
void RepresentationSeal::surface(SmObject* object) {
    require(object->GetType()==SmBSplineSurface_TYPE || object->GetType()==SmPlane_TYPE,"surface evaluator class is not supported by exact seal");
    surface_basis(object);
}
void RepresentationSeal::surface_basis(SmObject* object) {
    auto* s=static_cast<SmBSplineSurface*>(object);
    require(!s->HasAttributes() && s->GetGwNurbPointer() && !s->IsNurbBorrowed(),"missing, borrowed or attributed surface data in seal");
    require(s->GetBSplineSurfaceForm()!=SM_SF_POLYNOMIAL,"power-basis surfaces require separate exact seal");
    pointer(s->GetOwner()); word(s->IsOutOfBoundsEnabled()); word(s->IsUsingNewPointSolvers()); word(s->GetBSplineSurfaceForm());
    word(s->GetDegree(SM_SP_U)); word(s->GetDegree(SM_SP_V));
    const auto uv=s->GetNaturalUVDomain(); real(uv.GetUMin()); real(uv.GetUMax()); real(uv.GetVMin()); real(uv.GetVMax());
    ULONG nu=0,nv=0,ku=0,kv=0; double *control=nullptr,*u=nullptr,*v=nullptr;
    checked(s->GetControlPointsPointer(nu,nv,control)); checked(s->GetKnotsPointers(ku,kv,u,v));
    require(nu && nv && nu<=coefficients/4/nv && control && u && v && ku<=coefficients && kv<=coefficients &&
        ku==nu+s->GetDegree(SM_SP_U)+1 && kv==nv+s->GetDegree(SM_SP_V)+1,"unsupported surface coefficient support");
    word(nu); word(nv); word(ku); word(kv);
    for(ULONG i=0;i<4*nu*nv;++i) real(affine_slots?affine_slots->control(object,i,control[i]):control[i]);
    for(ULONG i=0;i<ku;++i) real(u[i]);
    for(ULONG i=0;i<kv;++i) real(v[i]);
    ULONG du=0,dv=0; SmBSplineSurfaceForm form; SmKnotType knot_type;
    SmTArray<SmPoint3d> points; SmTArray<ULONG> um,vm; SmTArray<double> uk,vk,weights;
    checked(s->GetCanonical(du,dv,points,form,um,vm,uk,vk,knot_type,weights));
    require(points.GetSize()==nu*nv && um.GetSize()==uk.GetSize() && vm.GetSize()==vk.GetSize() &&
        uk.GetSize()<=ku && vk.GetSize()<=kv && (weights.GetSize()==0 || weights.GetSize()==nu*nv),
        "surface canonical metadata does not cover actual support");
    word(du); word(dv); word(form); word(knot_type);
    if(object->GetType()==SmPlane_TYPE) {
        auto* plane=static_cast<SmPlane*>(object); const auto& frame=plane->GetPosition();
        for(auto point:{frame.GetOrigin(),frame.GetXAxis(),frame.GetYAxis(),frame.GetZAxis()}) { real(point.x); real(point.y); real(point.z); }
        const auto scale=plane->GetUVScale(); real(scale.x); real(scale.y);
        const auto step=plane->GetSTEPUVDomain(); real(step.GetUMin()); real(step.GetUMax()); real(step.GetVMin()); real(step.GetVMax());
    }
}
void RepresentationSeal::subdivision_surface(SmObject* object) {
    // #7955 / r6 event 787: the internal tessellation copy restores SmCone
    // evaluators from the rational input. This is NOT a generic seal extension
    // or permission to edit surfaces. Only the subdivision receipt calls here,
    // comparing the same actual incident surface before/after the edge split.
    if(object->GetType()!=SmCone_TYPE) { surface(object); return; }
    auto* cone=static_cast<SmCone*>(object);
    SmAxis2Placement frame; double radius=0,angle=0; SmBoolean swap,inside;
    checked(cone->SmCone::GetCanonical(frame,radius,angle,&swap,&inside));
    require(angle==0 && std::isfinite(radius) && radius>0 && cone->IsBounded(),
        "subdivision supports only materialized bounded cylindrical cones");
    surface_basis(object); // Same fixed control/knot/word, attribute and borrowing guards.
    word(object->GetType());
    for(auto p:{frame.GetOrigin(),frame.GetXAxis(),frame.GetYAxis(),frame.GetZAxis()}) {
        require(std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z),"nonfinite subdivision cone frame");
        real(p.x); real(p.y); real(p.z);
    }
    real(radius); real(angle); word(swap); word(inside); // subdivision-cone-analytic
    const auto step=cone->GetSTEPUVDomain();
    real(step.GetUMin()); real(step.GetUMax()); real(step.GetVMin()); real(step.GetVMax());
    word(RevolutionAccess::bounded_generator(*cone)); word(RevolutionAccess::planar_generator(*cone));
    auto* generator=cone->GetGenCurve();
    require(generator && generator->GetOwner()==cone && generator->GetDim()==3,
        "subdivision cone generator ownership");
    pointer(generator); word(generator->GetType()); curve(generator);
    // Polar-conversion tables are derived SDK caches, not additional authored
    // geometry. No cache mutation is authorized by this receipt; its analytic
    // frame/domain, basis and generator remain bit-exact. Do not use the SDK's
    // approximate SmPolarConversion::operator== as a representation proof.
}
}

namespace face_lineage {
void RepresentationSeal::require_exact_curve_copy(SmObject* from,SmObject* to) {
    require(from && to && from!=to && from->GetType()==to->GetType(),"trim copy evaluator class mismatch");
    scratch.clear(); curve(from); const auto count=scratch.size(); curve(to);
    require(scratch.size()==2*count && count>1 && std::equal(scratch.begin()+1,scratch.begin()+count,scratch.begin()+count+1),
        "trim copy changed exact coefficients/knots/domain/semantics");
    scratch.clear();
}
void RepresentationSeal::require_exact_surface_copy(SmObject* from,SmObject* to) {
    require(from && to && from!=to && from->GetType()==to->GetType(),"surface copy evaluator class mismatch");
    scratch.clear(); surface(from); const auto count=scratch.size(); surface(to);
    require(scratch.size()==2*count && count>1 && std::equal(scratch.begin()+1,scratch.begin()+count,scratch.begin()+count+1),
        "surface copy changed exact parameter representation");
    scratch.clear();
}
void NumericalRead::begin(Ledger& ledger,SmBrep& source) {
    ledger.verify_inventory(source);
    require(!ledger.numerical.source && ledger.frame_count,"nested/unowned numerical read phase refused");
    ledger.numerical.tessellation=false; ledger.numerical.copy_issued=false;
    ledger.numerical.copy=nullptr; ledger.numerical.copy_generation={};
    ledger.numerical.polygons.clear();
    ledger.numerical.trims.clear(); ledger.numerical.trims.reserve(8192);
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    for(auto* face:faces) {
        SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
        require(uses.GetSize()<=8192,"numerical read trim inventory exceeds bound");
        for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            require(trim && owner && trim->GetOwner()==owner && trim->GetDim()==2 && owner->GetBrep()==&source,
                "numerical read requires complete actual pre-existing owned UV trims");
            bool seen=false; for(auto* known:ledger.numerical.trims) seen|=known==trim;
            if(seen) continue;
            require(ledger.numerical.trims.size()<8192,"numerical read trim inventory exceeds bound");
            ledger.numerical.trims.push_back(trim);
        }
    }
    ledger.numerical.operation=ledger.append(Change::AuditBoundary); ledger.check();
    ledger.numerical.frame=ledger.frame_count; ledger.numerical.source=&source;
    ledger.numerical.serial=ledger.frames[ledger.frame_count-1]->serial;
}
void NumericalRead::end(Ledger& ledger) {
    if(!ledger.numerical.source || !ledger.frame_count || ledger.numerical.frame!=ledger.frame_count ||
        ledger.numerical.serial!=ledger.frames[ledger.frame_count-1]->serial) ledger.fail(Failure::UnknownHistory);
    if(ledger.subdivision) ledger.subdivision->finish();
    if(ledger.numerical.copy) ledger.fail(Failure::UnknownHistory); // internal-read-copy-survivor
    for(const auto& binding:ledger.bindings)
        if(binding.alive && binding.numerical_operation==ledger.numerical.operation) ledger.fail(Failure::UnknownHistory);
    ledger.subdivision.reset();
    ledger.numerical.source=nullptr; ledger.numerical.trims.clear(); ledger.check();
}
double NumericalRead::volume(Ledger& ledger,SmBrep& source,double accuracy) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"numerical read refused after terminal isolation failure"};
    require(source.GetContext() && std::isfinite(accuracy) && accuracy>0,"invalid owned volume-read inputs");
    auto& context=*const_cast<SmContext*>(source.GetContext()); raw_context::Restore restore(&context);
    Scope phase(ledger,context,&source); RepresentationSeal seal(ledger,source);
    begin(ledger,source);
    try {
        double result=0; const auto status=SmApiBrepComputeVolume(&source,accuracy,result);
        require(status==SM_SUCCESS,"actual SDK volume read failed"); ledger.check(); end(ledger); seal.verify(); ledger.verify_inventory(source);
        phase.finish(); ledger.check(); return result;
    } catch(...) { ledger.numerical.source=nullptr; rethrow_tainted_kernel_domain("fixed SDK volume read"); }
}
BoundaryProperties NumericalRead::face(Ledger& ledger,SmFace& face,SmOrientType orientation,double accuracy,
    const SmPoint3d& origin,double estimated_area) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"numerical read refused after terminal isolation failure"};
    auto* source=face.GetBrep();
    require(source && source->GetContext() && std::isfinite(accuracy) && accuracy>0 &&
        std::isfinite(estimated_area) && estimated_area>=0 && std::isfinite(origin.x) && std::isfinite(origin.y) && std::isfinite(origin.z) &&
        (orientation==SM_OT_SAME || orientation==SM_OT_OPPOSITE),"invalid owned boundary-read inputs");
    auto& context=*const_cast<SmContext*>(source->GetContext()); raw_context::Restore restore(&context);
    Scope phase(ledger,context,source); RepresentationSeal seal(ledger,*source);
    ledger.identity(&face); begin(ledger,*source);
    try {
        BoundaryProperties result; SmTArray<SmVector3d> moments;
        const auto status=face.ComputePreciseProperties(orientation,accuracy,origin,estimated_area,0.,result.area,result.volume,moments,
            SM_PPF_AREA|SM_PPF_VOLUME);
        require(status==SM_SUCCESS,"actual SDK boundary-property read failed"); ledger.check(); end(ledger); seal.verify(); ledger.verify_inventory(*source);
        phase.finish(); ledger.check(); return result;
    } catch(...) { ledger.numerical.source=nullptr; rethrow_tainted_kernel_domain("fixed SDK boundary-property read"); }
}
}
