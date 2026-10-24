// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPoly.h>
namespace face_lineage {
bool Ledger::numerical_copy_event(Event& event,SmNotifyOperation op,SmObject* caller,
    SmObject* a,SmObject* b,SmObject* c) {
    if(!numerical.source || !numerical.tessellation || !frame_count || numerical.frame!=frame_count ||
        numerical.serial!=frames[frame_count-1]->serial || !caller) return false;
    if(op==SM_NO_COPY && face(caller) && a && a->GetType()==SmPolyFace_TYPE) {
        // SmPoly.cpp:14446 propagates attributes, not BRep face ancestry.
        // PolyFace has no construction notification: never mint a face binding
        // or infer a generation for it. The event names its live original.
        const auto* source=binding(caller,false);
        const auto* body=numerical.copy?binding(numerical.copy,false):nullptr;
        auto* polygon=static_cast<SmPolyFace*>(a);
        if(b || c || !source || !source->alive || source->retired || !complete(source->current) ||
            !body || !body->alive || body->retired || body->current!=numerical.copy_generation ||
            source->birth_frame!=frame_count || source->owner!=numerical.copy ||
            static_cast<SmFace*>(caller)->GetBrep()!=numerical.copy ||
            polygon->GetOriginalFace()!=caller || !polygon->GetPolyBrep()) {
            fail(Failure::InvalidEvent); return true;
        }
        event.before[0]=source->current; // attributes-only receipt; no after identity
        return true;
    }
    if(op==SM_NO_COPY && caller->GetType()==SmEdgeuse_TYPE) {
        bool original_owner=false;
        for(auto* trim:numerical.trims)
            original_owner|=static_cast<SmCurve*>(trim)->GetOwner()==caller;
        if(!original_owner) return false;
        if(!a || a==caller || a->GetType()!=SmEdgeuse_TYPE ||
            static_cast<SmEdgeuse*>(caller)->GetBrep()!=numerical.source) {
            fail(Failure::InvalidEvent); return true;
        }
        auto* target=binding(a,false); const auto* birth=target?node(target->current):nullptr;
        if(!target || !target->alive || target->retired || target->birth_frame!=frame_count ||
            !birth || birth->change!=Change::Construct || target->numerical_owner_copy_operation==numerical.operation) {
            fail(Failure::UnknownHistory); return true;
        }
        // MergeBrep's real Edgeuse COPY receipt, not a guessed topology map.
        target->numerical_owner_origin=caller;
        target->numerical_owner_copy_operation=numerical.operation;
        // Once installed, this constructor is an internal original, forever
        // ineligible for the unattached-helper exemption in this generation.
        // A later silent SetOwner cannot disguise an installed trim as scratch.
        auto* use=static_cast<SmEdgeuse*>(a);
        for(auto* side:{use,use->GetMate()}) if(side)
            if(auto* attached=binding(side->GetUVTrimCurvePointer(),false))
                if(attached->alive && !attached->retired && attached->numerical_operation==numerical.operation)
                    attached->numerical_internal_original=true;
        return false;
    }
    if(caller->GetType()!=SmBrep_TYPE) return false;
    if(op==SM_NO_CONSTRUCTION && b==numerical.source) {
        // Pinned SmBrep.cpp:682 reports the completed copy, AFTER MergeBrep's
        // actual face-copy events. It names the original; a default constructor
        // or a copy of a sibling cannot acquire this read capability.
        if(a!=caller || c || caller==numerical.source || numerical.copy_issued) {
            fail(Failure::InvalidEvent); return true;
        }
        auto* entry=binding(caller,true);
        if(!entry || entry->alive) { fail(Failure::InvalidEvent); return true; }
        const auto address=entry->address; *entry=Binding{}; entry->address=address;
        const auto id=append(Change::Construct); replace(entry,id);
        entry->birth_frame=frame_count; entry->newborn=true; entry->owner=nullptr;
        entry->numerical_initialized=false;
        numerical.copy=static_cast<SmBrep*>(caller); numerical.copy_generation=id;
        numerical.copy_issued=true; event.after[0]=id;
        return true;
    }
    if(op==SM_NO_DESTRUCTION && caller==numerical.copy) {
        auto* entry=binding(caller,false);
        if(!entry || !entry->alive || entry->retired || entry->current!=numerical.copy_generation) {
            fail(Failure::UnknownHistory); return true;
        }
        event.before[0]=entry->current; entry->alive=false; entry->retired=true; entry->newborn=false;
        numerical.copy=nullptr; return true;
    }
    return false;
}
bool Ledger::numerical_copy_trim(SmObject* object,Identity generation) {
    if(!numerical.tessellation || !numerical.copy || !object) return false;
    const auto* body=binding(numerical.copy,false);
    const auto* entry=binding(object,false);
    const auto* birth=entry?node(entry->current):nullptr;
    // No dereference of an unobserved or retired address. Parent generation
    // equality also rejects a destructor/new-constructor reuse of the slot.
    if(!body || !body->alive || body->retired || body->current!=numerical.copy_generation ||
        !entry || !entry->alive || entry->retired || entry->birth_frame!=frame_count ||
        entry->numerical_operation!=numerical.operation || entry->numerical_parent.sequence ||
        !entry->numerical_internal_original ||
        !birth || birth->change!=Change::Construct ||
        (generation.sequence && entry->current!=generation)) return false;
    bool original=false;
    for(auto* trim:numerical.trims) original|=trim==entry->numerical_original;
    if(!original || object==entry->numerical_original || !object->IsKindOf(SmCurve_TYPE)) return false;
    auto* root=static_cast<SmCurve*>(entry->numerical_original);
    auto* root_owner=root->GetOwner();
    if(!root_owner || root_owner!=entry->numerical_owner || root_owner->GetType()!=SmEdgeuse_TYPE) return false;
    auto* root_use=static_cast<SmEdgeuse*>(root_owner); auto* root_mate=root_use->GetMate();
    if(root_use->GetBrep()!=numerical.source || !root_mate ||
        (root_use->GetUVTrimCurvePointer()!=root && root_mate->GetUVTrimCurvePointer()!=root)) return false;
    auto* curve=static_cast<SmCurve*>(object);
    auto* owner=curve->GetOwner();
    if(!owner || owner->GetType()!=SmEdgeuse_TYPE || curve->GetDim()!=2) return false;
    auto* use=static_cast<SmEdgeuse*>(owner); auto* mate=use->GetMate();
    const auto* owner_binding=binding(owner,false);
    if(!owner_binding || !owner_binding->alive || owner_binding->retired ||
        owner_binding->numerical_owner_copy_operation!=numerical.operation ||
        owner_binding->numerical_owner_origin!=root_owner) return false;
    // Attachment distinguishes the internal original from another temporary
    // helper. Only the latter may be edited by numerical_event.
    return use->GetBrep()==numerical.copy && mate &&
        (use->GetUVTrimCurvePointer()==curve || mate->GetUVTrimCurvePointer()==curve);
}
}
