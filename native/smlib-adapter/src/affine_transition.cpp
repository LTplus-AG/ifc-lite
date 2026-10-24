// SPDX-License-Identifier: MPL-2.0
#include "affine_transition_detail.hpp"
#include <SmCopyBrepMap.h>
#include <SmEdge.h>
#include <SmVertexuse.h>
#include <SmCurve.h>
#include <SmSurface.h>
#include <cstdio>
namespace face_lineage {
using namespace affine_detail;
AffineTransition::AffineTransition(Ledger& value,SmBrep& original,SmBrep& copy,const SmCopyBrepMap& map):
    ledger(value),source(original),working(copy) {
    require(!kernel_domain_is_tainted() && !ledger.active_affine && !ledger.active_transition &&
        !ledger.numerical.source && ledger.frame_count,"nested or unowned affine transition");
    ledger.verify_inventory(source); ledger.verify_inventory(working);
    require(&source!=&working && source.GetContext()==working.GetContext() &&
        map.GetOrigBrep()==&source && map.GetCopyBrep()==&working,"affine requires actual checked copy correspondence");
    frame=ledger.frame_count;
    const auto* entry=ledger.binding(&working,false);
    require(entry && entry->alive && !entry->retired,"affine target lacks observed constructor generation");
    generation=entry->current;
    SmTArray<SmFace*> from,to; source.GetFaces(from); working.GetFaces(to);
    require(from.GetSize()==to.GetSize() && to.GetSize() && to.GetSize()<=1024,"affine bounded complete face bijection");
    std::vector<SmFace*> seen;
    for(auto* face:to) {
        auto* parent=map.GetAt(face); SmFace* original_face=nullptr;
        for(auto* candidate:from) if(candidate==parent) original_face=candidate;
        require(original_face && std::find(seen.begin(),seen.end(),original_face)==seen.end(),"affine copy map is not bijective");
        seen.push_back(original_face);
        const auto prior=ledger.identity(face); auto ancestors=roots(ledger,prior);
        require(same_roots(ancestors,roots(ledger,ledger.identity(original_face))),"affine checked copy changed full source ancestor set");
        faces.push_back({face,prior,std::move(ancestors)});
    }
    protected_seals=protect(ledger,&working);
    seal=std::make_unique<RepresentationSeal>(ledger,working);
    capture(); operation=ledger.append(Change::AuditBoundary); ledger.check();
    // Freeze traversal order while separately checking every ownership/list
    // slot. Reflection may reorder SDK enumeration, not physical face identity.
    seal->affine_slots=this; seal->capture(); seal->retained=seal->scratch;
}
std::vector<std::unique_ptr<RepresentationSeal>> AffineTransition::protect(Ledger& ledger,SmBrep* excluded) {
    // Capture before copy as well as before numerical transition. No sibling
    // can acquire a new baseline after an unreported edit during the copy.
    std::vector<SmBrep*> owners;
    std::vector<std::unique_ptr<RepresentationSeal>> seals;
    for(const auto& b:ledger.bindings) if(b.alive && !b.retired && ledger.complete(b.current) && b.owner && b.owner!=excluded) {
        if(std::find(owners.begin(),owners.end(),b.owner)!=owners.end()) continue;
        require(owners.size()<8,"affine protected sibling budget"); owners.push_back(b.owner);
        seals.push_back(std::make_unique<RepresentationSeal>(ledger,*b.owner));
    }
    require(!seals.empty(),"affine source protection missing"); return seals;
}
void AffineTransition::verify_protected() {
    for(auto& seal:protected_seals) seal->verify();
}
void AffineTransition::verify_receipt() {
    ledger.check();
    require(position==expected_events.size(),"affine missing prescribed SDK notification");
    const auto* entry=ledger.binding(&working,false);
    require(entry && entry->alive && !entry->retired && entry->current==generation && ledger.frame_count==frame,
        "affine target or observation generation changed");
}
void AffineTransition::convert() {
    try {
        require(receipts==0,"affine conversion stage order"); verify_protected(); verify_target();
        expected_events.clear(); position=0;
        expect(SM_NO_PRE_EDIT,&working,&working,nullptr);
        ledger.active_affine=this;
        checked(working.TurnToNURBS()); // Already generic; no representation replacement or UV refit.
        ledger.active_affine=nullptr;
        verify_receipt(); verify_target(); verify_protected(); ++receipts;
    } catch(...) { ledger.active_affine=nullptr; ledger.fail(Failure::RepresentationChanged); rethrow_tainted_kernel_domain("affine conversion transition"); }
}
void AffineTransition::prepare_place(const SmAxis2Placement& placement,const SmVector3d* scale) {
    require(receipts==1 || receipts==2,"affine placement stage order");
    require((receipts==1)==(scale==nullptr),"affine prescribed proper-placement/signed-scale order");
    verify_protected(); verify_target(); plan_events(placement,scale); predict(placement,scale);
}
void AffineTransition::complete_place() {
    try {
        ledger.active_affine=nullptr;
        verify_receipt(); verify_target(); verify_protected(); ++receipts;
    } catch(...) { ledger.fail(Failure::RepresentationChanged); rethrow_tainted_kernel_domain("affine placement receipt"); }
}
void AffineTransition::place(const SmAxis2Placement& placement,const SmVector3d* scale) {
    try {
        prepare_place(placement,scale);
        ledger.active_affine=this;
        checked(working.Transform(placement,scale,FALSE));
        complete_place();
    } catch(...) { ledger.active_affine=nullptr; ledger.fail(Failure::RepresentationChanged); rethrow_tainted_kernel_domain("affine placement transition"); }
}
void AffineTransition::finish() {
    try {
        require(receipts==3,"affine missing semantic transition receipt");
        verify_receipt(); verify_protected();
        verify_target(); // affine-terminal-target
        // Every derived node retains the complete prior physical face identity;
        // no fresh root or guessed positional ancestry is introduced.
        for(const auto& face:faces) {
            auto* binding=ledger.binding(face.object,false);
            require(binding && binding->current==face.before,"affine physical face identity changed during numerical work");
            const auto derived=ledger.append(Change::Edit,face.before);
            ledger.replace(binding,derived); ledger.check();
            require(same_roots(face.roots,roots(ledger,derived)),"affine transition changed complete original ancestor set");
        }
        ledger.verify_inventory(working); verify_protected();
        seal->affine_slots=nullptr; ++receipts;
    } catch(...) { ledger.fail(Failure::RepresentationChanged); rethrow_tainted_kernel_domain("affine terminal transition"); }
}
void AffineTransition::expect(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    require(expected_events.size()<32768,"affine event plan budget");
    expected_events.push_back({op,caller,a,b,c});
}
bool AffineTransition::event(Event& event,SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    if(position==expected_events.size() || ledger.frame_count!=frame || !operation.sequence) {
        ledger.fail(Failure::InvalidEvent); return true;
    }
    const auto& expected=expected_events[position++];
    if(op!=expected.op || caller!=expected.caller || a!=expected.a || b!=expected.b || c!=expected.c ||
        !caller || caller->GetContext()!=working.GetContext()) {
        std::fprintf(stderr,"affine event mismatch stage=%u ordinal=%zu expected_op=%ld actual_op=%ld caller=%u a=%u b=%u c=%u\n",
            receipts,position,long(expected.op),long(op),unsigned(caller==expected.caller),unsigned(a==expected.a),unsigned(b==expected.b),unsigned(c==expected.c));
        ledger.fail(Failure::InvalidEvent);
    }
    event.before[0]=operation; event.after[0]=operation;
    return true; // Only the exact next event of this issued fixed SDK call.
}
void AffineTransition::plan_events(const SmAxis2Placement& placement,const SmVector3d* scale) {
    expected_events.clear(); position=0;
    if(placement.IsIdentity() && (!scale || *scale==SmVector3d(1,1,1))) return;
    expect(SM_NO_PRE_EDIT,&working,&working,nullptr);
    if(scale && (!SM_ARE_SAME(scale->x,scale->y) || !SM_ARE_SAME(scale->x,scale->z) || scale->x<SM_EFF_ZERO))
        expect(SM_NO_PRE_EDIT,&working,&working,nullptr); // Generic TurnToNURBS inside Transform.
    // Pinned SmTypes.h deliberately makes SM_NO_GET_* payloads null; actual
    // ownership is established by the captured graph, not these empty slots.
    SmTArray<SmVertex*> vertices; working.GetVertices(vertices);
    for(auto* vertex:vertices) {
        expect(SM_NO_PRE_EDIT,vertex,vertex,&working);
        SmTArray<SmVertexuse*> uses; vertex->GetVertexuses(uses);
        for(auto* use:uses) expect(SM_NO_CHANGE_GEOMETRY,use,nullptr,SM_NO_GET_BREP(vertex));
        expect(SM_NO_CHANGE_GEOMETRY,vertex,nullptr,SM_NO_GET_BREP(vertex));
    }
    SmTArray<SmCurve*> curves; working.GetCurves(curves);
    for(auto* curve:curves) {
        auto* owner=curve->GetOwner(); expect(SM_NO_PRE_EDIT,owner,owner,&working);
        expect(SM_NO_PRE_EDIT,curve,curve,SM_NO_GET_OWNER(curve)); expect(SM_NO_POST_EDIT,curve,curve,SM_NO_GET_OWNER(curve));
    }
    SmTArray<SmSurface*> surfaces; working.GetSurfaces(surfaces);
    for(auto* surface:surfaces) {
        auto* owner=surface->GetOwner(); expect(SM_NO_PRE_EDIT,owner,owner,&working);
        expect(SM_NO_PRE_EDIT,surface,surface,SM_NO_GET_OWNER(surface)); expect(SM_NO_POST_EDIT,surface,surface,SM_NO_GET_OWNER(surface));
    }
}
}
