// SPDX-License-Identifier: MPL-2.0
#include "planar_transition_detail.hpp"
#include <SmShell.h>
#include <SmAssertArray.h>
#include <SmLoopuse.h>
namespace face_lineage {
using namespace planar_detail;
void PlanarTransition::check_children() {
    ledger.verify_inventory(working);
    require(working.GetNumFaces()==pre_faces+1 && working.GetNumEdges()==pre_edges+1 &&
        working.GetNumVertices()==pre_vertices && diagonal && child && child_surface &&
        diagonal->IsManifold() && diagonal->GetEdgeuseCount()==4 && diagonal->GetCurve()==curve3 &&
        face.GetSurface()==support && child->GetSurface()==child_surface &&
        support->GetOwner()==&face && child_surface->GetOwner()==child,"planned two-fragment owners/cardinalities");
    pre_seal->require_exact_surface_copy(support,child_surface);
    require(born_count==16,"incomplete/extra fixed branch constructor inventory");
    const auto d3=linear(*curve3,3),d2=linear(*curve2,2);
    require(point(d3[0],points[0]) && point(d3[1],points[3]) && point(d2[0],uv[0]) && point(d2[1],uv[3]),
        "changed planned diagonal coefficients");
    pre_seal->require_exact_curve_copy(curve2,cut_copy);
    unsigned boundary[4]{},interiors[2]{};
    for(unsigned k=0;k<2;++k) {
        auto* fragment=k?child:&face; SmTArray<SmLoop*> loops; fragment->GetLoops(loops);
        SmTArray<SmEdgeuse*> uses; fragment->GetUpwardEdgeuses(uses);
        SmTArray<SmVertex*> vertices; fragment->GetVertices(vertices);
        require(loops.GetSize()==1 && loops[0]->IsOuterLoop() && loops[0]->IsClosedPtrs() &&
            uses.GetSize()==3 && vertices.GetSize()==3,"planned triangular fragment topology");
        unsigned mask=0;
        for(auto* vertex:vertices) {
            unsigned hits=0; for(unsigned c=0;c<4;++c) if(vertex==corners[c]) { mask|=1u<<c; ++hits; }
            require(hits==1,"unplanned fragment vertex generation");
        }
        require(mask==11 || mask==13,"triangle must have diagonal endpoints and one rectangle corner");
        for(auto* use:uses) {
            require(use->GetBrep()==&working && !use->GetDropCurveFail(),"foreign/failed fragment boundary");
            auto* trim=use->GetUVTrimCurve(); owner(use,fragment,working,trim);
            if(use->GetEdge()==diagonal) {
                ++interiors[k]; require(trim==curve2 || trim==cut_copy,"diagonal raw trim substitution");
                auto* entry=ledger.binding(trim,false);
                require(entry && entry->alive && !entry->retired && entry->owned_transition==receipt.operation &&
                    entry->birth_frame==frame && ledger.node(entry->current)->change==Change::Construct,
                    "diagonal UV generation not issued by this transition");
                require(use->GetRadial() && use->GetRadial()->GetEdge()==diagonal &&
                    use->GetRadial()->GetFace()==(k?&face:child) && !use->IsStrut(),"diagonal complete two-face radial incidence");
            } else {
                unsigned hits=0;
                for(unsigned i=0;i<4;++i) if(use==slots[i].use) {
                    ++hits; ++boundary[i]; require(trim==slots[i].original,"original boundary trim replaced during split");
                }
                require(hits==1,"unplanned fragment boundary use");
            }
        }
    }
    require(interiors[0]==1 && interiors[1]==1,"unique diagonal incidence in both fragments");
    for(auto count:boundary) require(count==1,"boundary correspondence missing/duplicated");
    auto* entry=ledger.binding(diagonal,false);
    require(entry && entry->alive && !entry->retired && entry->current==diagonal_birth &&
        entry->birth_frame==frame,"issued diagonal generation changed");
}
void PlanarTransition::numeric_check(bool split) {
    // Only existing fixed read wrappers execute while the topology event gate
    // is suspended. The continuous observer/unknown-hook/source guards remain.
    ledger.verify_inventory(working); require(working.IsManifoldSolid(),"transition closed manifold invariant");
    SmAssertArray reports;
    const auto status=working.ValidatePointers(&reports,SM_LEVEL_2);
    checked(status,"transition topology validation status");
    const bool clean=reports.GetSize()==0;
    require(clean,"transition topology validation report");
    SmTArray<SmFace*> all; working.GetFaces(all);
    for(auto* item:all) {
        SmTArray<SmLoop*> loops; item->GetLoops(loops);
        for(auto* loop:loops) require(loop->IsClosedPtrs() && loop->IsClosed3d(),"transition exact boundary closure");
    }
    const double volume=NumericalRead::volume(ledger,working,1e-8);
    double area=0,contribution=0;
    for(auto* item:{&face,split?child:nullptr}) if(item) {
        auto* use=item->GetUpwardFaceuse();
        if(use->GetShell()->GetRegion()==working.GetInfiniteRegion()) use=use->GetMate();
        auto properties=NumericalRead::face(ledger,*item,use->GetOrientation(),1e-8,SmPoint3d(0,0,0),pre_area);
        require(properties.area>0,"nonpositive planned fragment signed area");
        area+=properties.area; contribution+=properties.volume;
    }
    require(std::isfinite(volume) && std::abs(volume-pre_volume)<=1e-8 &&
        std::abs(area-pre_area)<=1e-8 && std::abs(contribution-pre_face_volume)<=1e-8,
        "transition strict signed volume/area boundary integrals");
    ledger.check(); source_seal->verify();
}
uint64_t PlanarTransition::expected_slot_pointer(const void* actual) const {
    require(step==Step::Complete && discharged && ledger.frame_count==frame &&
        ledger.identity(&face)==receipt.merged,"unissued/stale typed slot discharge");
    for(const auto& slot:slots) if(actual==slot.attached) {
        const auto* entry=ledger.binding(slot.attached,false);
        require(entry && entry->alive && !entry->retired && entry->current==slot.birth &&
            entry->owned_transition==receipt.operation && entry->birth_frame==frame,
            "replaced planned post UV generation");
        // An expected numeric SLOT token from the retained pre-representation.
        // It is never dereferenced or installed as a physical-object identity.
        return slot.original_slot;
    }
    return reinterpret_cast<uintptr_t>(actual);
}
Identity PlanarTransition::expected_face_slot(SmFace* actual,Identity current) const {
    if(actual!=&face) return current;
    require(discharged && step==Step::Complete && current==receipt.merged,"unissued physical face slot transition");
    return receipt.parent; // expected role only; live ledger/root lookup uses current
}
void PlanarTransition::verify_slots() {
    for(unsigned i=0;i<original_count;++i) {
        const auto& slot=original_slots[i]; const auto* entry=ledger.binding(slot.object,false);
        require(entry && entry->alive && !entry->retired && entry->current==slot.generation &&
            slot.object->GetBrep()==&working && slot.object->GetOwner()==slot.owner,
            "stale/replaced/foreign original topology generation/owner slot");
    }
}
void PlanarTransition::restore_heads() {
    require(step==Step::Restore && !head_restorations,"reused/unissued original loop-head restoration");
    SmTArray<SmLoop*> actual; face.GetLoops(actual);
    require(actual.GetSize()==1 && actual[0]==original_loop && original_loop->IsOuterLoop(),
        "foreign/substituted original loop role");
    for(unsigned side=0;side<2;++side) {
        verify_slots(); auto* lu=original_loopuses[side]; auto* primary=original_heads[side];
        require(lu->GetLoop()==original_loop && lu->GetOtherLoopuse()==original_loopuses[1-side] &&
            lu->GetFaceuse()->GetFace()==&face && lu->GetFaceuse()->GetOrientation()==(side?SM_OT_OPPOSITE:SM_OT_SAME) &&
            primary->GetLoopuse()==lu && original_loop->IsClosedPtrs(),"original head/loop/face owner correspondence");
        auto* next=primary; unsigned seen=0;
        for(unsigned j=0;j<4;++j) {
            require(next && (!j || next!=primary) && next->GetLoopuse()==lu &&
                next->GetFaceuse()==lu->GetFaceuse() && next->GetBrep()==&working &&
                next->GetCWEdgeuse() && next->GetCCWEdgeuse() &&
                next->GetCCWEdgeuse()->GetCWEdgeuse()==next && next->GetCWEdgeuse()->GetCCWEdgeuse()==next,
                "original head exact closed cyclic incidence");
            unsigned hits=0;
            for(unsigned k=0;k<4;++k) if(next==(side?slots[k].use->GetMate():slots[k].use)) {
                require(!(seen&(1u<<k)),"duplicate original head cyclic use slot"); seen|=1u<<k; ++hits;
            }
            require(hits==1,"foreign/substituted original head cyclic inventory"); next=next->GetCCWEdgeuse();
        }
        require(next==primary && seen==15,"missing original head cyclic use slot");
        // Public status-bearing topology transition, source SmLoopuse.cpp:66.
        // Every unexpected callback remains refused in Step::Restore.
        const auto status=lu->CollectEdgeuses(primary); ledger.check(); checked(status,"checked original primary-use restoration");
        require(lu->GetEUorVU()==primary,"SDK original primary-use postcondition");
        ++head_restorations; verify_slots();
    }
}
void PlanarTransition::discharge() {
    verify_slots();
    require(step==Step::Restore && head_restorations==2 && split_events==1 && merge_events==1 && edge_pre==1 &&
        working.GetNumFaces()==pre_faces && face.GetSurface()==support,"incomplete operation transition");
    SmTArray<SmEdgeuse*> uses; face.GetUpwardEdgeuses(uses);
    require(uses.GetSize()==4,"post rectangle complete inventory");
    for(auto& slot:slots) {
        unsigned hits=0; for(auto* use:uses) hits+=use==slot.use;
        require(hits==1 && slot.attached && !slot.use->GetDropCurveFail(),"post planned boundary substitution");
        owner(slot.use,&face,working,slot.attached);
        const auto controls=linear(*slot.attached,2); const auto same=slot.use->GetOrientation()==SM_OT_SAME?0:1;
        require(point(controls[same],uv[slot.from]) && point(controls[1-same],uv[slot.to]) &&
            slot.use->GetVertexuse()->GetVertex()==corners[slot.from] &&
            slot.use->GetMate()->GetVertexuse()->GetVertex()==corners[slot.to],"post numeric/incidence substitution mismatch");
    }
    // The exact four corner/edge/UV correspondences above prove the original
    // rectangle before restoring this public derived flag. No numeric read is
    // admitted until the complete typed leaf discharge also succeeds.
    face.SetIsRectangularTrim(old_rect);
    // Discharge every retained topology/numeric/context/source leaf, allowing
    // only the private four UV slot substitutions and derived face role.
    // This is not original/current graph equality or old physical authority.
    step=Step::Complete; discharged=true; pre_seal->transition_slots=this;
    try { pre_seal->capture(); }
    catch(...) { pre_seal->transition_slots=nullptr; discharged=false; throw; }
    pre_seal->transition_slots=nullptr;
    require(pre_seal->scratch==pre_seal->retained,"planned transition leaves differ from authenticated pre-source");
    post_seal=std::make_unique<RepresentationSeal>(ledger,working); // real new identities, no slot mapping
    receipt.revision=ledger.append(Change::AuditBoundary,receipt.parent,receipt.merged); ledger.check();
}
}
