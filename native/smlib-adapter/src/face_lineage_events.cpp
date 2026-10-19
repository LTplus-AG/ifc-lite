// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmFace.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <SmSurface.h>
#include <SmTopology.h>
#include <array>
namespace face_lineage {
bool Ledger::face(SmObject* object) const { return object && object->GetType()==SmFace_TYPE; }
void Ledger::observe(SmNotifyOperation operation,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    if(failure!=Failure::None) return;
    if(event_count==limits.events) { fail(Failure::EventLimit); return; }
    auto& record=events[event_count++]; record.operation=operation;
    try { transition(record,operation,caller,a,b,c); }
    catch(...) { fail(Failure::InvalidEvent); }
}
void Ledger::transition(Event& event,SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    // REG_PROPAGATION carries array addresses, not objects. Never inspect them.
    if(op==SM_NO_REG_PROPAGATION) return;
    if(numerical_event(event,op,caller,b)) return;
    // Follow only documented live caller ownership, with a bounded cycle check.
    // Do not inspect arbitrary event payload slots (some contain arrays).
    const bool mutation=op!=SM_NO_COPY && op!=SM_NO_CONSTRUCTION && op!=SM_NO_COINCIDENT;
    SmObject* owner=caller; SmBrep* owner_brep=nullptr;
    std::array<SmObject*,64> seen{}; unsigned depth=0;
    // Construction/destruction callers can have incomplete/torn ownership.
    // Face destruction uses only the binding captured before graph teardown.
    while(owner && mutation && op!=SM_NO_DESTRUCTION) {
        if(depth==seen.size()) { fail(Failure::UnknownHistory); return; }
        for(unsigned i=0;i<depth;++i) if(seen[i]==owner) { fail(Failure::UnknownHistory); return; }
        seen[depth++]=owner;
        if(owner->IsKindOf(SmSurface_TYPE)) owner=static_cast<SmSurface*>(owner)->GetOwner();
        else if(owner->IsKindOf(SmCurve_TYPE)) owner=static_cast<SmCurve*>(owner)->GetOwner();
        else if(owner->GetType()==SmEdgeuse_TYPE) owner=static_cast<SmEdgeuse*>(owner)->GetEdge();
        else {
            if(owner->GetType()==SmBrep_TYPE) owner_brep=static_cast<SmBrep*>(owner);
            else if(owner->IsKindOf(SmTopology_TYPE)) owner_brep=static_cast<SmTopology*>(owner)->GetBrep();
            break;
        }
    }
    if(readonly(owner_brep) && mutation) { fail(Failure::ReadOnlyMutation); return; }
    guard_numerical(op,caller,a,b,c);
    if(failure!=Failure::None) return;
    auto current=[&](SmObject* object,bool require_complete=true)->Binding* {
        auto* entry=binding(object,false);
        if(!entry || !entry->alive || entry->retired || (require_complete && !complete(entry->current))) {
            fail(Failure::UnknownHistory); return nullptr;
        }
        return entry;
    };
    auto writable=[&](Binding* entry) {
        if(entry && readonly(entry->owner)) fail(Failure::ReadOnlyMutation);
        return entry && failure==Failure::None;
    };
    const bool leaf=caller && (caller->GetType()==SmEdge_TYPE || caller->GetType()==SmVertex_TYPE);
    if(op==SM_NO_CONSTRUCTION && leaf) {
        auto* entry=binding(caller,true);
        if(!entry) return;
        if(entry->alive) { fail(Failure::InvalidEvent); return; }
        const auto id=append(Change::Construct); replace(entry,id); entry->newborn=true; entry->owner=nullptr;
        entry->birth_frame=frame_count; entry->numerical_initialized=false;
        event.after[0]=id; return;
    }
    if(op==SM_NO_DESTRUCTION && leaf) {
        if(auto* entry=binding(caller,false)) {
            event.before[0]=entry->current; entry->alive=false; entry->retired=true; entry->newborn=false;
        }
        return;
    }
    if(op==SM_NO_CONSTRUCTION && face(caller)) {
        auto* entry=binding(caller,true);
        if(!entry) return;
        if(entry->alive) { fail(Failure::InvalidEvent); return; }
        const auto id=append(Change::Construct);
        replace(entry,id); entry->removed=false; entry->owner=nullptr;
        entry->newborn=true; entry->birth_frame=frame_count; entry->numerical_initialized=false;
        entry->initial_issuance=frames[frame_count-1]->phase==Phase::InitialConstruction;
        event.after[0]=id; return;
    }
    if(op==SM_NO_COPY && face(caller)) {
        auto* from=current(caller); if(!from) return;
        if(!face(a) || a==caller) { fail(Failure::InvalidEvent); return; }
        auto* to=current(a,false); if(!writable(to)) return;
        to->initial_issuance=false;
        event.before[0]=from->current;
        // A copy onto an already-mated face is a provenance union, never an
        // overwrite of the first operand's origins (MakeFaceuse fast path).
        const auto prior=complete(to->current)?to->current:Identity{};
        event.before[1]=prior;
        const auto id=append(Change::Copy,from->current,prior);
        replace(to,id); to->owner=static_cast<SmFace*>(a)->GetBrep(); event.after[0]=id; return;
    }
    if(op==SM_NO_SPLIT_IN_BREP && face(a)) {
        if(caller!=a && (!caller || caller->GetType()!=SmBrep_TYPE)) return;
        auto* parent=current(a); if(!writable(parent)) return;
        if(!face(b) || !face(c) || b==c) { fail(Failure::InvalidEvent); return; }
        auto* one=current(b,false); auto* two=current(c,false);
        if(!writable(one) || !writable(two)) return;
        const auto original=parent->current; event.before[0]=original;
        if((one!=parent && complete(one->current)) || (two!=parent && complete(two->current))) {
            fail(Failure::InvalidEvent); return;
        }
        // Original may be reused as child1. Freeze its OLD identity before
        // replacing either binding; the split graph cannot become self-cyclic.
        const auto first=append(Change::Split,original);
        const auto second=append(Change::Split,original);
        if(failure!=Failure::None) return;
        if(parent!=one && parent!=two) parent->retired=true;
        replace(one,first); replace(two,second);
        one->owner=static_cast<SmFace*>(b)->GetBrep(); two->owner=static_cast<SmFace*>(c)->GetBrep();
        event.after[0]=first; event.after[1]=second; return;
    }
    if(op==SM_NO_MERGE_IN_BREP && face(a)) {
        if(caller!=a && (!caller || caller->GetType()!=SmBrep_TYPE)) return;
        if(!face(b) || a==b) { fail(Failure::InvalidEvent); return; }
        auto* survivor=current(a); auto* removed=current(b);
        if(!writable(survivor) || !writable(removed)) return;
        event.before[0]=survivor->current; event.before[1]=removed->current;
        const auto id=append(Change::Merge,survivor->current,removed->current);
        if(failure!=Failure::None) return;
        removed->retired=true; replace(survivor,id); event.after[0]=id; return;
    }
    if(op==SM_NO_DESTRUCTION && face(caller)) {
        auto* entry=binding(caller,false);
        if(!entry || !entry->alive) { fail(Failure::UnknownHistory); return; }
        if(!writable(entry)) return;
        event.before[0]=entry->current;
        // No later query dereferences this address. A subsequent constructor at
        // the same address starts a distinct generation with unknown origins.
        entry->alive=false; entry->retired=true; entry->owner=nullptr; return;
    }
    if((op==SM_NO_ADD_TO_BREP || op==SM_NO_RM_FROM_BREP || op==SM_NO_TRIM_NO_SPLIT_IN_BREP) && face(a)) {
        auto* entry=current(a,false); if(!writable(entry)) return;
        // The public MakeFaceTopology constructor emits one initial ADD after
        // completing the face. Removal, trimming or a second ADD is history,
        // never constructor-only first issuance.
        const auto* before=node(entry->current);
        if(op!=SM_NO_ADD_TO_BREP || !before || before->change!=Change::Construct ||
            entry->birth_frame!=frame_count) entry->initial_issuance=false;
        event.before[0]=entry->current;
        const auto id=append(op==SM_NO_RM_FROM_BREP?Change::Remove:Change::Add,entry->current);
        replace(entry,id); entry->removed=op==SM_NO_RM_FROM_BREP;
        if(op!=SM_NO_RM_FROM_BREP && caller && caller->GetType()==SmBrep_TYPE) entry->owner=static_cast<SmBrep*>(caller);
        event.after[0]=id; return;
    }
    if(op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT || op==SM_NO_CHANGE_GEOMETRY) {
        if(face(caller)) {
            auto* entry=current(caller,false); if(!writable(entry)) return;
            // A first surface attachment is constructor initialization only.
            // A replacement (old surface in c), PRE/POST edit or later phase
            // permanently excludes initial issuance even without roots.
            if(op!=SM_NO_CHANGE_GEOMETRY || c || entry->birth_frame!=frame_count)
                entry->initial_issuance=false;
            if(op==SM_NO_CHANGE_GEOMETRY && complete(entry->current)) fail(Failure::UnsupportedGeometryChange);
        }
        return;
    }
    switch(op) {
        case SM_NO_CONSTRUCTION: case SM_NO_COPY: case SM_NO_SPLIT_IN_BREP:
        case SM_NO_MERGE_IN_BREP: case SM_NO_DESTRUCTION: case SM_NO_ADD_TO_BREP:
        case SM_NO_RM_FROM_BREP: case SM_NO_TRIM_NO_SPLIT_IN_BREP:
        case SM_NO_COINCIDENT: case SM_NO_CHANGE_OWNER: case SM_NO_SPLIT:
        case SM_NO_MERGE: return; // non-face events; no face ancestry asserted
        default: fail(Failure::InvalidEvent);
    }
}
Scope::Scope(Ledger& value,SmContext& ctx,SmBrep* source,Phase kind):ledger(value),context(ctx),previous(ctx.GetUserNotifyCallback()),phase(kind) {
    ledger.check();
    if(ledger.closed) { ledger.fail(Failure::ObservationGap); ledger.check(); }
    if(ledger.frame_count==ledger.limits.callback_depth) { ledger.fail(Failure::CallbackDepthLimit); ledger.check(); }
    if((ledger.context && ledger.context!=&context) || (ledger.attached && previous!=ledger.observer)) {
        ledger.fail(Failure::ReentrantCallback); ledger.check();
    }
    // Inventory/protection happens before any slot change. No SDK mutation has
    // started if this preflight refuses. The system callback is never claimed.
    ledger.protect(source); ledger.context=&context;
    owns_callback=!ledger.attached;
    if(owns_callback) {
        context.SetUserNotifyCallback(this); ledger.attached=true; ledger.observer=this;
    }
    frame=ledger.frame_count++; ledger.frames[frame]=this; ledger.protected_sources[frame]=source;
    installed=true;
}
void Scope::finish() noexcept {
    if(!installed) return;
    if(context.GetUserNotifyCallback()!=ledger.observer) ledger.fail(Failure::CallbackReplaced);
    if(ledger.frame_count!=frame+1 || ledger.frames[frame]!=this) ledger.fail(Failure::InvalidEvent);
    else {
        ledger.frames[frame]=nullptr; ledger.protected_sources[frame]=nullptr; --ledger.frame_count;
    }
    for(auto& entry:ledger.bindings) if(entry.birth_frame==frame+1) { entry.newborn=false; entry.initial_issuance=false; }
    if(owns_callback) {
        // A detached observer cannot silently miss destruction/reconstruction
        // and then reuse a final raw address as historical identity.
        for(const auto& entry:ledger.bindings)
            if(entry.alive && !entry.retired && ledger.complete(entry.current)) ledger.fail(Failure::ObservationGap);
        context.SetUserNotifyCallback(previous);
        ledger.attached=false; ledger.observer=nullptr; ledger.closed=true;
    }
    installed=false;
}
Scope::~Scope() { finish(); }
SmStatus Scope::Execute(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    // Install incoming identity BEFORE depth/reentrancy can latch. Nested
    // callbacks restore the exact outer event context, including early exits.
    struct EventContext {
        SmNotifyOperation& operation; long& type; uint32_t& event;
        SmNotifyOperation old_operation; long old_type; uint32_t old_event;
        ~EventContext() { operation=old_operation; type=old_type; event=old_event; }
    } restore{ledger.current_operation,ledger.current_type,ledger.current_event,
        ledger.current_operation,ledger.current_type,ledger.current_event};
    ledger.current_operation=op; ledger.current_type=caller?long(caller->GetType()):0;
    ledger.current_event=ledger.event_count+1;
    if(depth==ledger.limits.callback_depth) { ledger.fail(Failure::CallbackDepthLimit); return SM_ERR; }
    // Foreign hooks may query freely. Nested notifying edits/construction have
    // no issued operation authority here; preserve callback delivery, refuse
    // the phase, and still bound recursive foreign behavior.
    if(depth && op!=SM_NO_COPY && op!=SM_NO_COINCIDENT && op!=SM_NO_REG_PROPAGATION)
        ledger.fail(Failure::ReentrantCallback);
    ++depth;
    ledger.observe(op,caller,a,b,c);
    if(previous) {
        try { if(previous->Execute(op,caller,a,b,c)!=SM_SUCCESS) ledger.fail(Failure::ForeignStatus); }
        catch(...) { ledger.fail(Failure::ForeignException); }
    }
    --depth;
    return ledger.failed()==Failure::None?SM_SUCCESS:SM_ERR;
}
}
