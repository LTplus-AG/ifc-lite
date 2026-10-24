// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <SmCurve.h>
#include <SmBSplineCurve.h>
#include <SmEdgeuse.h>
// Pinned SDK c9c5979: SmFace.cpp:7360-7375 copies an actual UV trim,
// assigns its original owner as a backlink, then reverses the uninstalled copy.
// SmCurve.h:1245-1256 reports the source from the live copy constructor before
// derived data exists. This is a generation capability, never address history.

namespace face_lineage {
bool Ledger::numerical_event(Event& event,SmNotifyOperation op,SmObject* caller,SmObject* original) {
    if(!numerical.source || !frame_count || numerical.frame!=frame_count ||
        numerical.serial!=frames[frame_count-1]->serial || !caller) return false;
    if(!caller->IsKindOf(SmCurve_TYPE)) return false;
    if(op==SM_NO_CONSTRUCTION) {
        // SmCurve's base constructor reports the actual source in b before
        // derived numerical data exists. No deferred address-history lookup.
        bool known=false; for(auto* trim:numerical.trims) known|=trim==original;
        if(!known) {
            // A recycled address never keeps a previous helper capability.
            if(auto* stale=binding(caller,false)) {
                if(stale->alive && stale->numerical_operation.sequence) fail(Failure::UnknownHistory);
                stale->numerical_operation={}; stale->numerical_original=nullptr; stale->numerical_owner=nullptr;
            }
            return false;
        } // Unowned helpers have no exemption.
        for(auto* trim:numerical.trims) if(trim==caller) { fail(Failure::InvalidEvent); return true; }
        auto* entry=binding(caller,true);
        if(!entry || entry->alive) { fail(Failure::InvalidEvent); return true; }
        const auto id=append(Change::Construct); replace(entry,id);
        entry->numerical_operation=numerical.operation; entry->owned_transition={};
        entry->numerical_original=original;
        entry->numerical_owner=static_cast<SmCurve*>(original)->GetOwner(); entry->birth_frame=frame_count; event.after[0]=id;
        return true;
    }
    // Destruction of an inventoried original is not temporary retirement.
    if(op==SM_NO_DESTRUCTION) for(auto* trim:numerical.trims) if(trim==caller) {
        fail(Failure::ReadOnlyMutation); return true;
    }
    auto* entry=binding(caller,false);
    if(!entry || !entry->alive || entry->retired || entry->numerical_operation!=numerical.operation ||
        entry->birth_frame!=frame_count) return false;
    if(op==SM_NO_DESTRUCTION) { event.before[0]=entry->current; entry->alive=false; entry->retired=true; return true; }
    if(op!=SM_NO_PRE_EDIT && op!=SM_NO_POST_EDIT) return false;
    auto* curve=static_cast<SmCurve*>(caller); auto* owner=curve->GetOwner();
    // The SDK sets a copied trim's owner backlink before reversing it.
    // Bind that backlink to THIS constructor's original, not any trim owner.
    bool original_known=false;
    for(auto* trim:numerical.trims) original_known|=trim==entry->numerical_original;
    if(!original_known || caller==entry->numerical_original || owner!=entry->numerical_owner ||
        !owner || owner->GetType()!=SmEdgeuse_TYPE || curve->GetDim()!=2 ||
        (caller->GetType()!=SmBSplineCurve_TYPE && caller->GetType()!=SmLine_TYPE)) {
        fail(Failure::UnsupportedGeometryChange); return true;
    }
    auto* use=static_cast<SmEdgeuse*>(owner);
    auto* source=static_cast<SmCurve*>(entry->numerical_original);
    auto* mate=use->GetMate();
    // Pointer-only getters: no lazy trim creation during notification. The
    // original remains actually attached; the edited copy must be unattached.
    if(use->GetBrep()!=numerical.source || source->GetOwner()!=owner || !mate ||
        (use->GetUVTrimCurvePointer()!=source && mate->GetUVTrimCurvePointer()!=source) ||
        use->GetUVTrimCurvePointer()==curve || mate->GetUVTrimCurvePointer()==curve) {
        fail(Failure::UnsupportedGeometryChange); return true;
    }
    event.before[0]=entry->current;
    const auto edited=append(Change::Edit,entry->current); replace(entry,edited); event.after[0]=edited;
    return true;
}
}
