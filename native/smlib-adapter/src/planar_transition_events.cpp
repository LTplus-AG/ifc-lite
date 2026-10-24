// SPDX-License-Identifier: MPL-2.0
#include "planar_transition_detail.hpp"
#include <SmSurface.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
namespace face_lineage {
bool PlanarTransition::born_object(SmObject* object) const {
    for(unsigned i=0;i<born_count;++i) if(born[i].object==object && !born[i].destroyed) return true;
    return false;
}
void PlanarTransition::retire_curve(Event& event,SmObject* object) {
    auto* binding=ledger.binding(object,false);
    if(binding && binding->alive) {
        event.before[0]=binding->current; binding->alive=false; binding->retired=true;
    }
}
bool PlanarTransition::event(Event& event,SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) {
    auto refuse=[&]() { ledger.fail(Failure::InvalidEvent); return true; };
    if(!caller || caller->GetContext()!=working.GetContext() || frame!=ledger.frame_count || !receipt.operation.sequence) return refuse();
    const auto type=caller->GetType();
    // Only actual base constructors can issue private curve generations.
    if(op==SM_NO_CONSTRUCTION && type==SmCurve_TYPE) {
        const bool prepared=step==Step::Prepare && expecting_birth && !pending_birth && b==copy_source;
        const bool cut=step==Step::Insert && !cut_copy && b==curve2;
        if((!prepared && !cut) || caller==b || a!=caller || c) return refuse();
        auto* entry=ledger.binding(caller,true);
        if(!entry || entry->alive) return refuse();
        const auto id=ledger.append(Change::Construct); ledger.replace(entry,id);
        entry->owned_transition=receipt.operation; entry->numerical_operation={}; entry->birth_frame=frame;
        event.after[0]=id;
        if(prepared) { pending_birth=caller; pending_generation=id; }
        else cut_copy=static_cast<SmBSplineCurve*>(caller);
        return true;
    }
    if(op==SM_NO_CONSTRUCTION && step==Step::Insert) {
        unsigned limit=0;
        if(type==SmEdge_TYPE || type==SmFace_TYPE || type==SmSurface_TYPE || type==SmLoop_TYPE) limit=1;
        if(type==SmFaceuse_TYPE || type==SmLoopuse_TYPE) limit=2;
        if(type==SmEdgeuse_TYPE || type==SmVertexuse_TYPE) limit=4;
        unsigned count=0; for(unsigned i=0;i<born_count;++i) count+=born[i].type==type;
        if(!limit || count==limit || born_count==born.size() || a!=caller || c ||
            (type==SmSurface_TYPE?b!=support:b!=nullptr) || born_object(caller)) return refuse();
        born[born_count++]={caller,{},type,false};
        if(type==SmSurface_TYPE) child_surface=static_cast<SmSurface*>(caller);
        auto* entry=ledger.binding(caller,true);
        if(!entry || entry->alive) return refuse();
        const auto id=ledger.append(Change::Construct); ledger.replace(entry,id);
        entry->owner=nullptr; entry->birth_frame=frame; entry->newborn=true;
        entry->numerical_initialized=false; entry->initial_issuance=false;
        entry->owned_transition=receipt.operation; entry->numerical_operation={};
        born[born_count-1].generation=id; event.after[0]=id;
        if(type==SmEdge_TYPE) { diagonal=static_cast<SmEdge*>(caller); diagonal_birth=id; }
        if(type==SmFace_TYPE) { child=static_cast<SmFace*>(caller); child_birth=id; }
        return true; // Generation receipt only, never complete face/root authority.
    }
    if(step==Step::Insert) {
        if(op==SM_NO_CHANGE_GEOMETRY && caller==diagonal && a==curve3 && !c &&
            b==diagonal->GetBrep() && ++edge_geometry==1) return false;
        if(op==SM_NO_CHANGE_OWNER && !c && caller==curve3 && a==diagonal &&
            b==diagonal->GetBrep() && ++curve_owner==1) return false;
        if(op==SM_NO_CHANGE_OWNER && !c && caller==child_surface && a==child &&
            b==child->GetBrep() && ++surface_owner==1) return false;
        if(op==SM_NO_PRE_EDIT && caller==&face && a==caller && b==&working && !c && ++face_pre[0]==1) return false;
        if(op==SM_NO_ADD_TO_BREP && caller==&working && a==diagonal && b==&working && c==curve3 && ++add_events==1) return false;
        if(op==SM_NO_SPLIT_IN_BREP && caller==&working && a==&face && b==&face && c==child &&
            ++split_events==1 && ledger.identity(&face)==receipt.parent) return false;
        // CopyAndAddAnalytics announces no face copy: only numerical construction.
    }
    if(step==Step::Delete) {
        if(op==SM_NO_PRE_EDIT && caller==&working && a==caller && !b && !c && ++brep_pre==1) return false;
        if(op==SM_NO_PRE_EDIT && caller==diagonal && a==caller && !b && !c && ++edge_pre==1) {
            auto* binding=ledger.binding(caller,false);
            if(!binding || !binding->alive || binding->retired || binding->current!=diagonal_birth ||
                diagonal->GetBrep()!=&working || diagonal->GetEdgeuseCount()!=4 || diagonal->GetCurve()!=curve3 ||
                ledger.identity(&face)!=receipt.children[0] || ledger.identity(child)!=receipt.children[1]) return refuse();
            // Sole topology invalidation exception: exact newly issued diagonal,
            // after the complete two-fragment incidence leaf has been discharged.
            event.before[0]=diagonal_birth; return true;
        }
        if(op==SM_NO_RM_FROM_BREP && caller==&working && a==diagonal && b==&working && !c &&
            edge_pre==1 && ++remove_events==1) return false;
        // #7955/r10 event 641: after deleting the diagonal, DeleteEdge:6502
        // removes the issued child loop. RemoveLoop has its own PRE/POST pair,
        // distinct from RemoveUVTrimCurves. Its face ancestry is already retired.
        if(caller==child && (op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT) && face_pre[1]==2) {
            auto* entry=ledger.binding(child,false);
            if(a!=caller || b || c || merge_events!=1 || destroyed_curve_count!=7 ||
                !entry || !entry->alive || !entry->retired || entry->current!=receipt.children[1] ||
                child->GetBrep()!=&working || child->GetSurface()!=child_surface) return refuse();
            bool diagonal_dead=false; unsigned dead_uses=0;
            for(unsigned i=0;i<born_count;++i) {
                diagonal_dead|=born[i].object==diagonal && born[i].destroyed;
                dead_uses+=born[i].destroyed && (born[i].type==SmEdgeuse_TYPE || born[i].type==SmVertexuse_TYPE);
            }
            if(!diagonal_dead || dead_uses!=8) return refuse();
            if(op==SM_NO_PRE_EDIT) {
                if(loop_remove_pre || loop_remove_post) return refuse();
                SmTArray<SmLoop*> loops; child->GetLoops(loops);
                if(loops.GetSize()!=1) return refuse();
                removing_loop=loops[0]; removing_loop->GetLoopuses(removing_loopuses[0],removing_loopuses[1]);
                for(auto* object:{static_cast<SmObject*>(removing_loop),static_cast<SmObject*>(removing_loopuses[0]),
                    static_cast<SmObject*>(removing_loopuses[1])}) {
                    bool issued=false;
                    for(unsigned i=0;i<born_count;++i) if(born[i].object==object && !born[i].destroyed) {
                        auto* binding=ledger.binding(object,false);
                        issued=binding && binding->alive && !binding->retired && binding->current==born[i].generation &&
                            binding->owned_transition==receipt.operation && binding->birth_frame==frame;
                    }
                    if(!issued) return refuse();
                }
                if(removing_loopuses[0]==removing_loopuses[1] ||
                    !removing_loopuses[0]->GetFaceuse() || !removing_loopuses[1]->GetFaceuse() ||
                    removing_loopuses[0]->GetFaceuse()->GetFace()!=child ||
                    removing_loopuses[1]->GetFaceuse()->GetFace()!=child) return refuse();
                loop_remove_pre=1;
            } else {
                if(loop_remove_pre!=1 || loop_remove_post || !removing_loop) return refuse();
                SmTArray<SmLoop*> loops; child->GetLoops(loops);
                if(loops.GetSize()!=0 || removing_loopuses[0]->GetFaceuse() || removing_loopuses[1]->GetFaceuse()) return refuse();
                loop_remove_post=1;
            }
            event.before[0]=entry->current; // removed-loop receipt never resurrects child ancestry
            return true;
        }
        if(op==SM_NO_PRE_EDIT && (caller==&face || caller==child) && a==caller && !c) {
            const unsigned index=caller==&face?0:1;
            // DeleteEdge's explicit pre-merge face notice names the BRep;
            // RemoveUVTrimCurves after MERGE uses SM_NO_GET_BREP, null in this
            // pinned build. Bind that notice to the exact second slot, not a
            // general null-owner PRE_EDIT exemption (SmFace.cpp:12915).
            if(b!=(merge_events==1?nullptr:&working) || face_pre[index]!=(merge_events==1?1u:0u)) return refuse();
            if(++face_pre[index]>2) return refuse();
            if(index==1 && merge_events==1) {
                auto* entry=ledger.binding(child,false);
                // The merge event retires ancestry before the SDK removes UVs
                // from the still-live removed fragment. Never resurrect it.
                if(!entry || !entry->alive || !entry->retired || entry->current!=receipt.children[1] ||
                    child->GetBrep()!=&working || child->GetSurface()!=child_surface) return refuse();
                event.before[0]=entry->current; return true;
            }
            return false;
        }
        if(op==SM_NO_MERGE_IN_BREP && caller==&working && a==&face && b==child && c==&working &&
            ++merge_events==1 && face.GetSurface()==support && support->GetOwner()==&face &&
            ledger.identity(&face)==receipt.children[0] && ledger.identity(child)==receipt.children[1]) return false;
        if(op==SM_NO_DESTRUCTION && a==caller && !b && !c) {
            bool trim=caller==curve2 || caller==cut_copy || caller==curve3;
            for(const auto& slot:slots) trim|=caller==slot.original;
            if(trim) {
                for(unsigned i=0;i<destroyed_curve_count;++i) if(destroyed_curves[i]==caller) return refuse();
                if(destroyed_curve_count==destroyed_curves.size()) return refuse();
                destroyed_curves[destroyed_curve_count++]=caller;
                retire_curve(event,caller); return true;
            }
            for(unsigned i=0;i<born_count;++i) if(born[i].object==caller && !born[i].destroyed) {
                auto* entry=ledger.binding(caller,false);
                const auto expected=caller==child?receipt.children[1]:born[i].generation;
                if(!entry || !entry->alive || entry->current!=expected || entry->owned_transition!=receipt.operation ||
                    entry->birth_frame!=frame) return refuse();
                born[i].destroyed=true;
                if(caller==child || caller==diagonal) return false; // normal face/edge retirement
                event.before[0]=entry->current; entry->alive=false; entry->retired=true; return true;
            }
        }
    }
    // No edits, transient constructions, replacement geometries, retries,
    // foreign graphs or alternative SDK branches inherit this authority.
    return refuse();
}
}
