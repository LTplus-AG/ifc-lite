// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmEdgeuse.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <SmPoly.h>
namespace face_lineage {
bool Ledger::numerical_copy_event(Event& event,SmNotifyOperation op,SmObject* caller,
    SmObject* a,SmObject* b,SmObject* c) {
    if(!numerical.source || !numerical.tessellation || !frame_count || numerical.frame!=frame_count ||
        numerical.serial!=frames[frame_count-1]->serial || !caller) return false;
    // Observe the actual 3D curve constructor during MergeBrep. Unlike a
    // temporary 2D trim, this grants no edit authority; subdivision must still
    // snapshot its attached representation and complete the full protocol.
    if(op==SM_NO_CONSTRUCTION && caller->IsKindOf(SmCurve_TYPE) && b && b->IsKindOf(SmCurve_TYPE)) {
        auto* original=static_cast<SmCurve*>(b); auto* owner=original->GetOwner();
        if(original->GetDim()==3 && owner && owner->GetType()==SmEdge_TYPE &&
            static_cast<SmEdge*>(owner)->GetBrep()==numerical.source && !numerical.copy_issued) {
            if(a!=caller || c) { fail(Failure::InvalidEvent); return true; }
            auto* entry=binding(caller,true);
            if(!entry || entry->alive) { fail(Failure::InvalidEvent); return true; }
            const auto address=entry->address; *entry=Binding{}; entry->address=address;
            const auto id=lifetime(entry,Change::Construct); replace(entry,id);
            entry->birth_frame=frame_count; entry->owned_transition=numerical.operation;
            event.after[0]=id; return true;
        }
    }
    if(op==SM_NO_COPY && face(caller) && a && a->GetType()==SmPolyFace_TYPE) {
        // SmPoly.cpp:14446 propagates attributes, not BRep face ancestry.
        // PolyFace has no construction notification: never mint a face binding
        // or infer a generation for it. The event names its live original.
        const auto* source=binding(caller,false);
        const auto* body=numerical.copy?binding(numerical.copy,false):nullptr;
        auto* polygon=static_cast<SmPolyFace*>(a);
        if(b || c || !source || !source->alive || source->retired || !complete(source->current) ||
            !body || !body->alive || body->retired || body->current!=numerical.copy_generation ||
            polygon->GetOriginalFace()!=caller || !polygon->GetPolyBrep()) {
            fail(Failure::InvalidEvent); return true;
        }
        if(source->owner==numerical.copy && source->birth_frame==frame_count &&
            static_cast<SmFace*>(caller)->GetBrep()==numerical.copy) {
            for(const auto& receipt:numerical.polygons) if(receipt.polygon==polygon) {
                fail(Failure::InvalidEvent); return true;
            }
            if(numerical.polygons.size()==8192) { fail(Failure::EventLimit); return true; }
            numerical.polygons.push_back({polygon,polygon->GetPolyBrep(),source->numerical_face_input,false});
        } else {
            // ConvertToPolyBrep:37540-37552 rebinds the finished polygon through
            // the SDK's actual copy map. Match the preceding attribute receipt
            // to the exact original identity observed in the face COPY event.
            // This consumes an attribute receipt, never issues polygon ancestry.
            auto found=numerical.polygons.end();
            for(auto it=numerical.polygons.begin();it!=numerical.polygons.end();++it)
                if(it->polygon==polygon) { found=it; break; }
            if(source->owner!=numerical.source || static_cast<SmFace*>(caller)->GetBrep()!=numerical.source ||
                found==numerical.polygons.end() || found->rebound || found->body!=polygon->GetPolyBrep() ||
                found->input!=source->current) { // polygon-original-receipt
                fail(Failure::InvalidEvent); return true;
            }
            found->rebound=true;
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
        auto* target=binding(a,false);
        if(!target || !target->alive || target->retired || target->birth_frame!=frame_count ||
            !constructed(target) || target->numerical_owner_copy_operation==numerical.operation) {
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
        const auto id=lifetime(entry,Change::Construct); replace(entry,id);
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
    if(body && body->alive && !body->retired && body->current==numerical.copy_generation &&
        entry && entry->alive && !entry->retired && entry->birth_frame==frame_count &&
        entry->subdivision_operation==numerical.operation &&
        (!generation.sequence || entry->current==generation)) {
        auto* owner=binding(entry->subdivision_attachment,false);
        if(!owner || !owner->alive || owner->retired || owner->current!=entry->subdivision_owner ||
            !object->IsKindOf(SmCurve_TYPE)) return false;
        auto* curve=static_cast<SmCurve*>(object);
        auto* use=static_cast<SmEdgeuse*>(entry->subdivision_attachment);
        return curve->GetDim()==2 && curve->GetOwner()==use && use->GetBrep()==numerical.copy &&
            use->GetUVTrimCurvePointer()==curve;
    }
    // No dereference of an unobserved or retired address. Parent generation
    // equality also rejects a destructor/new-constructor reuse of the slot.
    if(!body || !body->alive || body->retired || body->current!=numerical.copy_generation ||
        !entry || !entry->alive || entry->retired || entry->birth_frame!=frame_count ||
        entry->numerical_operation!=numerical.operation || entry->numerical_parent.sequence ||
        !entry->numerical_internal_original ||
        !constructed(entry) ||
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
