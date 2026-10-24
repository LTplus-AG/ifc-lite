// SPDX-License-Identifier: MPL-2.0
// #7955: actual owned reconstruction, inventory authority and outward coverage.
// SDK/native/Emscripten execution is parent-owned and UNRUN at authoring time.
#include "plane_owned_domain.hpp"
#include "plane_inventory.hpp"
#include "plane_source_domain.hpp"
#include "plane.hpp"
#include "affine.hpp"
#include "copy.hpp"
#include <SmApiPrimitives.h>
#include <SmBSplineCurve.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <SmParabola.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <SmSurface.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
using Solid=std::unique_ptr<SmBrep>;
void demand(bool value,const char* text) {
    if(!value) { std::fprintf(stderr,"plane owned FAIL: %s\n",text); std::exit(1); }
}
template<class F> bool refuses(F action,const char* message=nullptr) {
    try { action(); }
    catch(const AdapterFailure& e) {
        return e.status==IFCLITE_SMLIB_UNSUPPORTED && (!message || std::strstr(e.message,message));
    }
    return false;
}
Solid source(bool clipped=false) {
    SmBrep* raw=nullptr;
    demand(SmApiCreateBox(SmVector3d(7,-5,11),4,6,8,raw)==SM_SUCCESS && raw,"source box");
    Solid original(raw);
    if(clipped) {
        const double plane[]={9,0,0,1,0,0}; ifclite_smlib_plane_certificate c{};
        original=clip_finite_plane(original.get(),plane,1,IFCLITE_SMLIB_INTERSECTION,c);
    }
    const double identity[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    ifclite_smlib_affine_certificate c{};
    return copy_affine_rational(original.get(),identity,c);
}
SmFace* first_face(SmBrep* b) {
    SmTArray<SmFace*> faces; b->GetFaces(faces); demand(faces.GetSize()==6,"six source faces");
    return faces[0];
}
SmEdgeuse* first_use(SmFace* f) {
    SmTArray<SmEdgeuse*> uses; f->GetUpwardEdgeuses(uses);
    demand(uses.GetSize()==4,"four source uses"); return uses[0];
}
SmLoopuse* opposite_loop(SmBrep* b) {
    SmTArray<SmLoop*> loops; first_face(b)->GetLoops(loops);
    demand(loops.GetSize()==1,"one loop for opposite-side seal fixture");
    auto* primary=loops[0]->GetLoopuse(); auto* other=primary->GetOtherLoopuse();
    demand(other && other!=primary,"distinct opposite loopuse fixture"); return other;
}
SmEdgeuse* nonprimary_mate(SmBrep* b) {
    SmTArray<SmLoop*> loops; first_face(b)->GetLoops(loops);
    SmTArray<SmEdgeuse*> uses; loops[0]->GetEdgeuses(uses);
    for(auto* use:uses) {
        auto* mate=use->GetMate();
        if(mate && mate!=use->GetEdge()->GetPrimaryEdgeuse() &&
            mate->GetLoopuse()!=loops[0]->GetLoopuse()) return mate;
    }
    demand(false,"nonprimary opposite edgeuse fixture"); return nullptr;
}
template<class T,class F> bool orientation_edit(T* use,F verify,const char* expected) {
    const auto saved=use->GetOrientation();
    demand(saved==SM_OT_SAME || saved==SM_OT_OPPOSITE,"known fixture orientation");
    use->SetOrientation(saved==SM_OT_SAME?SM_OT_OPPOSITE:SM_OT_SAME);
    const bool rejected=refuses(verify,expected);
    use->SetOrientation(saved); // restore even when the negative is red
    return rejected;
}
void opposite_side_seal() {
    // OWNED-DOMAIN-01: raw setters change semantics without editing any
    // primary-side scalar. Never evaluate or Boolean the malformed graph.
    auto original=source(); PreparedPlaneOperand prepared(original.get());
    const auto saved=plane_inventory(prepared.get(),true);
    demand(orientation_edit(opposite_loop(prepared.get()),[&]{prepared.verify(prepared.get());},"inventory changed"),
        "opposite loopuse orientation invalidates sealed inventory");
    demand(plane_inventory(prepared.get(),true)==saved,"opposite loopuse restore preserves inventory");
    prepared.verify(prepared.get());
    demand(orientation_edit(nonprimary_mate(prepared.get()),[&]{prepared.verify(prepared.get());},"plane inventory"),
        "nonprimary mate orientation invalidates sealed inventory");
    demand(plane_inventory(prepared.get(),true)==saved,"mate edgeuse restore preserves inventory");
    prepared.verify(prepared.get());
    const auto source_saved=plane_inventory(original.get(),true);
    demand(orientation_edit(opposite_loop(original.get()),[&]{prepared.verify_source();},"mutated source inventory"),
        "source opposite orientation invalidates source inventory");
    demand(plane_inventory(original.get(),true)==source_saved,"source opposite restore preserves inventory");
    prepared.verify_source(); prepared.verify(prepared.get());
}
void evaluator_metadata_seal() {
    auto original=source(); PreparedPlaneOperand prepared(original.get());
    auto* face=first_face(prepared.get()); const auto saved=plane_inventory(prepared.get(),true);
    const auto rectangular=face->GetRectangularTrim();
    face->SetIsRectangularTrim(rectangular==TRUE?FALSE:TRUE);
    const bool rejected=refuses([&]{prepared.verify(prepared.get());},"inventory changed");
    face->SetIsRectangularTrim(rectangular);
    demand(rejected,"rectangular-trim metadata invalidates sealed inventory");
    demand(plane_inventory(prepared.get(),true)==saved,"rectangular-trim restore preserves inventory");
    prepared.verify(prepared.get());
    auto* surface=face->GetSurface(); const auto solver=surface->IsUsingNewPointSolvers();
    surface->SetUseNewPointSolvers(solver==TRUE?FALSE:TRUE);
    const bool solver_rejected=refuses([&]{prepared.verify(prepared.get());},"inventory changed");
    surface->SetUseNewPointSolvers(solver);
    demand(solver_rejected,"point-solver policy invalidates sealed inventory");
    demand(plane_inventory(prepared.get(),true)==saved,"point-solver restore preserves inventory");
    prepared.verify(prepared.get());
}
void lifecycle() {
    auto original=source(true);
    const auto before=plane_inventory(original.get(),true);
    auto flags=preflight_plane_source(original.get());
    bool missing=false; for(bool f:flags) missing|=f;
    demand(missing,"observed clip identity source still has missing trims");
    PreparedPlaneOperand prepared(original.get());
    demand((prepared.domain().methods&8)!=0,"owned reconstruction must report method8");
    demand(plane_inventory(original.get(),true)==before,"preparation preserves exact source inventory");
    prepared.verify(prepared.get());
    demand(refuses([&]{prepared.verify(original.get());},"foreign or consumed"),"foreign operand cannot reuse domain");
    SmTArray<SmVertex*> vertices; prepared.get()->GetVertices(vertices);
    demand(vertices.GetSize()>0,"owned vertices");
    const auto saved=vertices[0]->GetPoint(); auto moved=saved;
    moved.x=std::nextafter(saved.x,INFINITY); vertices[0]->SetPoint(moved);
    demand(refuses([&]{prepared.verify(prepared.get());},"inventory changed"),"one ULP invalidates sealed inventory");
    vertices[0]->SetPoint(saved); prepared.verify(prepared.get());
    auto result=prepared.consume(prepared.get());
    demand(refuses([&]{prepared.consume(result.get());},"foreign or consumed"),"consumed domain cannot replay");
    result.reset(); prepared.verify_source();
    demand(plane_inventory(original.get(),true)==before,"source survives prepared operand release");
}
void malformed_sources() {
    auto original=source(); auto* face=first_face(original.get()); auto* use=first_use(face);
    auto* vertex=use->GetEdge()->GetStartVertex();
    const auto saved=vertex->GetPoint();
    for(unsigned d=0;d<3;++d) {
        auto displaced=saved; displaced[d]=std::nextafter(saved[d],INFINITY); vertex->SetPoint(displaced);
        demand(refuses([&]{preflight_plane_source(original.get());}),"one ULP source topology displacement refuses");
        vertex->SetPoint(saved);
    }
    preflight_plane_source(original.get());
    // An unknown analytic dispatch must refuse BEFORE SDK copy/evaluation.
    use->GetEdge()->SetCurve(new (*original->GetContext()) SmParabola(),TRUE);
    demand(refuses([&]{PreparedPlaneOperand p(original.get());}),"unknown source curve refuses before reconstruction");
    demand(!kernel_domain_is_tainted(),"unsupported source is not evaluated or tainted");
}
void omitted_and_foreign() {
    auto original=source(); PreparedPlaneOperand prepared(original.get());
    auto* face=first_face(prepared.get()); auto* use=first_use(face);
    SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
    demand(trim && owner,"owned complete trim");
    auto* saved_owner=trim->GetOwner(); trim->SetOwner(original.get());
    demand(refuses([&]{prepared.verify(prepared.get());},"foreign"),"foreign trim owner invalidates authority");
    trim->SetOwner(saved_owner); prepared.verify(prepared.get());
    face->RemoveUVTrimCurves();
    demand(refuses([&]{prepared.verify(prepared.get());},"inventory changed"),"omitted trim invalidates sealed inventory");
    std::vector<bool> flags(6,true);
    demand(refuses([&]{certify_owned_plane_domain(prepared.get(),flags);},"omitted UV trim"),
        "owned domain refuses omitted UV inventory");
}
void enclosure() {
    auto original=source(); PreparedPlaneOperand prepared(original.get());
    auto* face=first_face(prepared.get());
    const auto map=plane_source_proof::inspect_reconstruction_candidate(face).map;
    auto* trim=first_use(face)->GetUVTrimCurve(); ULONG n=0; double* p=nullptr;
    demand(trim && trim->GetControlPointsPointer(n,p)==SM_SUCCESS && n==2,"linear owned trim controls");
    const auto d=map.u_axis; const double width=map.u[3]-map.u[0];
    // Domain-only adversarial invariant; this altered object is NEVER clipped
    // or evaluated and cannot pass prepared.verify(). Independent affine math
    // supplies expected extrema, not production interval operations.
    p[0]=map.u[0]-2*width; p[1]=map.v[0];
    p[4]=map.u[3]+2*width; p[5]=map.v[3];
    const double lo=std::min(map.controls[d],map.controls[8+d]);
    const double hi=std::max(map.controls[d],map.controls[8+d]);
    const auto domain=certify_owned_plane_domain(prepared.get(),std::vector<bool>(6,true));
    demand(domain.bounds[d].lo<=lo-2*(hi-lo) && domain.bounds[d].hi>=hi+2*(hi-lo),
        "owned bound covers complete reconstructed UV image");
    demand(refuses([&]{prepared.verify(prepared.get());}),"post-seal trim edit cannot reach Boolean");
}
}
int main() {
    try { lifecycle(); opposite_side_seal(); evaluator_metadata_seal(); malformed_sources(); omitted_and_foreign(); enclosure(); }
    catch(const KernelDomainTainted& e) {
        // A report mutation must fail its own runtime contract, not crash.
        if(e.message.find("lost method8 provenance")!=std::string::npos)
            demand(false,"owned reconstruction must report method8");
        std::fprintf(stderr,"plane owned FAIL: unexpected taint: %s\n",e.message.c_str()); return 1;
    } catch(const AdapterFailure& e) {
        std::fprintf(stderr,"plane owned FAIL: unexpected refusal: %s\n",e.message); return 1;
    }
    std::puts("plane owned PASS");
}
