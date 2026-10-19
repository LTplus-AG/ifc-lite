// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmSurface.h>
#include <SmFace.h>
#include <SmFaceuse.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
namespace face_lineage {
void Ledger::affect_numerical_face(SmFace* face,bool initialization) {
    if(!face) return;
    auto* entry=binding(face,false);
    if(readonly(face->GetBrep())) { fail(Failure::ReadOnlyMutation); return; }
    if(!entry || !entry->alive || entry->retired) { fail(Failure::UnknownHistory); return; }
    // Rooted history never inherits a same-frame/newborn numerical exemption.
    if(complete(entry->current)) { fail(Failure::UnsupportedGeometryChange); return; }
    if(!initialization) entry->initial_issuance=false;
}
void Ledger::affect_numerical_owner(SmObject* object,bool initialization) {
    // Resolve only actual live ownership, never historical addresses. No SDK
    // array getters: their incident-face collectors allocate while notifying.
    std::array<SmObject*,64> seen{}; uint32_t depth=0;
    while(object && (object->IsKindOf(SmCurve_TYPE) || object->IsKindOf(SmSurface_TYPE))) {
        if(depth==seen.size()) { fail(Failure::UnknownHistory); return; }
        for(uint32_t i=0;i<depth;++i) if(seen[i]==object) { fail(Failure::UnknownHistory); return; }
        seen[depth++]=object;
        object=object->IsKindOf(SmCurve_TYPE)?static_cast<SmCurve*>(object)->GetOwner():static_cast<SmSurface*>(object)->GetOwner();
    }
    if(!object) return; // Unattached numerical data is not yet a face boundary.
    const auto type=object->GetType();
    if(type==SmFace_TYPE) { affect_numerical_face(static_cast<SmFace*>(object),initialization); return; }
    if(type==SmEdgeuse_TYPE) {
        auto* use=static_cast<SmEdgeuse*>(object);
        if(readonly(use->GetBrep())) { fail(Failure::ReadOnlyMutation); return; }
        affect_numerical_face(use->GetFace(),initialization); return;
    }
    if(type==SmVertexuse_TYPE) {
        auto* use=static_cast<SmVertexuse*>(object); auto* faceuse=use->GetFaceuse();
        if(readonly(use->GetBrep())) { fail(Failure::ReadOnlyMutation); return; }
        affect_numerical_face(faceuse?faceuse->GetFace():nullptr,initialization); return;
    }
    if(type==SmEdge_TYPE || type==SmVertex_TYPE) {
        auto* leaf=static_cast<SmTopology*>(object);
        if(readonly(leaf->GetBrep())) { fail(Failure::ReadOnlyMutation); return; }
        SmTopology* first=nullptr; ULONG count=0;
        if(type==SmEdge_TYPE) {
            auto* edge=static_cast<SmEdge*>(object); first=edge->GetPrimaryEdgeuse(); count=edge->GetEdgeuseCount();
        } else {
            auto* vertex=static_cast<SmVertex*>(object); first=vertex->GetPrimaryVertexuse(); count=vertex->GetSize();
        }
        if(count>limits.nodes || bool(count)!=bool(first)) { fail(Failure::InvalidInventory); return; }
        auto* use=first;
        for(ULONG i=0;i<count;++i) {
            if(!use || (i && use==first) || use->GetOwner()!=object) { fail(Failure::InvalidInventory); return; }
            if(type==SmEdge_TYPE) {
                if(use->GetType()!=SmEdgeuse_TYPE) { fail(Failure::InvalidInventory); return; }
                affect_numerical_face(static_cast<SmEdgeuse*>(use)->GetFace(),initialization);
            } else {
                if(use->GetType()!=SmVertexuse_TYPE) { fail(Failure::InvalidInventory); return; }
                auto* faceuse=static_cast<SmVertexuse*>(use)->GetFaceuse();
                affect_numerical_face(faceuse?faceuse->GetFace():nullptr,initialization);
            }
            if(failure!=Failure::None) return;
            use=use->GetNext();
        }
        if(count && use!=first) fail(Failure::InvalidInventory);
        return;
    }
    // An unexpected attached numerical owner cannot silently certify history.
    fail(Failure::UnknownHistory);
}
void Ledger::guard_numerical(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    if(!caller) return;
    const bool geometry=caller->IsKindOf(SmCurve_TYPE) || caller->IsKindOf(SmSurface_TYPE);
    if(op==SM_NO_CHANGE_OWNER && geometry) {
        if(creation_owner(caller,a,c)) return;
        // Only these documented slots contain owner objects. First attachment
        // is distinct from transfer/detachment. UV SetOwner is silent in SDK.
        if(c) affect_numerical_owner(c,false);
        if(failure==Failure::None && a) affect_numerical_owner(a,c==nullptr);
        return;
    }
    if((op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT) && caller->GetType()==SmFace_TYPE) {
        // MakeEdgeInFaceWithVU emits face PRE_EDIT for a topological split
        // (SmBrep.cpp:12710,13318). It is not a surface numerical mutation.
        // Keep fragment topology in the event ledger; incomplete constructor
        // history still loses first-issuance eligibility on a later edit.
        auto* entry=binding(caller,false);
        if(entry) entry->initial_issuance=false;
        return;
    }
    if(geometry && (op==SM_NO_SPLIT || op==SM_NO_MERGE)) {
        // SPLIT/MERGE document c as the numerical result's owner, even when
        // GetOwner() has already been cleared. MERGE also names both originals.
        affect_numerical_owner(caller,false);
        if(failure==Failure::None && c) affect_numerical_owner(c,false);
        if(op==SM_NO_MERGE) for(auto* original:{a,b}) {
            if(failure==Failure::None && original) affect_numerical_owner(original,false);
        }
        return;
    }
    const bool numerical=op==SM_NO_CHANGE_GEOMETRY || op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT ||
        ((op==SM_NO_SPLIT || op==SM_NO_MERGE) && geometry);
    if(!numerical) return;
    bool initialization=false;
    const auto type=caller->GetType();
    if(op==SM_NO_CHANGE_GEOMETRY && (type==SmFace_TYPE || type==SmEdge_TYPE || type==SmVertex_TYPE)) {
        auto* leaf=binding(caller,false);
        const bool fresh=leaf && leaf->alive && !leaf->retired && leaf->newborn && leaf->birth_frame==frame_count;
        // The actual old-geometry slot distinguishes the first surface/curve
        // attachment. Vertex SetPoint has no old value: permit only its first
        // actual setter after construction, never all setters in that frame.
        initialization=fresh && !leaf->numerical_initialized && !c;
        if(leaf) leaf->numerical_initialized=true;
    }
    if(type==SmFace_TYPE || type==SmEdge_TYPE || type==SmVertex_TYPE || type==SmEdgeuse_TYPE || type==SmVertexuse_TYPE || geometry)
        affect_numerical_owner(caller,initialization);
}
}

namespace face_lineage {
bool Ledger::numerical_event(Event& event,SmNotifyOperation op,SmObject* caller,SmObject* original) {
    if(!numerical.source || numerical.frame!=frame_count || !caller) return false;
    if(!caller->IsKindOf(SmCurve_TYPE)) return false;
    if(op==SM_NO_CONSTRUCTION) {
        // SmCurve's base constructor reports the actual source in b before
        // derived numerical data exists. No deferred address-history lookup.
        bool known=false; for(auto* trim:numerical.trims) known|=trim==original;
        if(!known) return false; // Unowned helpers have no exemption.
        for(auto* trim:numerical.trims) if(trim==caller) { fail(Failure::InvalidEvent); return true; }
        auto* entry=binding(caller,true);
        if(!entry || entry->alive) { fail(Failure::InvalidEvent); return true; }
        const auto id=append(Change::Construct); replace(entry,id);
        entry->numerical_operation=numerical.operation; entry->owned_transition={}; entry->birth_frame=frame_count; event.after[0]=id;
        return true;
    }
    auto* entry=binding(caller,false);
    if(!entry || !entry->alive || entry->retired || entry->numerical_operation!=numerical.operation ||
        entry->birth_frame!=frame_count) return false;
    if(op==SM_NO_DESTRUCTION) { event.before[0]=entry->current; entry->alive=false; entry->retired=true; return true; }
    if(op!=SM_NO_PRE_EDIT && op!=SM_NO_POST_EDIT) return false;
    auto* curve=static_cast<SmCurve*>(caller); auto* owner=curve->GetOwner();
    bool known_owner=false;
    // A copied trim's backlink can name a source edgeuse. Authority comes
    // from its current constructor generation, never from that backlink.
    for(auto* trim:numerical.trims) known_owner|=static_cast<SmCurve*>(trim)->GetOwner()==owner;
    if(!known_owner || !owner || owner->GetType()!=SmEdgeuse_TYPE || curve->GetDim()!=2 ||
        (caller->GetType()!=SmBSplineCurve_TYPE && caller->GetType()!=SmLine_TYPE)) {
        fail(Failure::UnsupportedGeometryChange); return true;
    }
    auto* use=static_cast<SmEdgeuse*>(owner);
    if(use->GetBrep()!=numerical.source || use->GetUVTrimCurve()==curve || use->GetUVTrimCurvePointer()==curve ||
        !use->GetMate() || use->GetMate()->GetUVTrimCurvePointer()==curve) {
        fail(Failure::UnsupportedGeometryChange); return true;
    }
    event.before[0]=entry->current;
    const auto edited=append(Change::Edit,entry->current); replace(entry,edited); event.after[0]=edited;
    return true;
}
}
