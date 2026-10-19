// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include "representation_seal.hpp"
#include <SmBSplineCurve.h>
#include <SmBrep.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPlane.h>
#include <SmVertex.h>
namespace face_lineage {
class TransitionReceipt {
    Identity operation{},revision{},parent{},children[2]{},merged{};
    friend class PlanarTransition;
public:
    Identity physical_revision() const { return revision; }
    Identity before() const { return parent; }
    Identity fragment(unsigned i) const { return i<2?children[i]:Identity{}; }
    Identity after() const { return merged; }
};
// Adapter-only typed operation transition, never authored-object equality.
// The constructor/plan/substitution tables are private; no mutator or flags.
class PlanarTransition {
    enum class Step { Prepare,Classify,Insert,Delete,Restore,Complete } step=Step::Prepare;
    struct Slot {
        SmEdgeuse* use=nullptr; SmBSplineCurve* original=nullptr;
        std::unique_ptr<SmBSplineCurve> retained;
        SmBSplineCurve* attached=nullptr; Identity birth{};
        unsigned from=0,to=0; uintptr_t original_slot=0;
    };
    Ledger& ledger; SmBrep& source; SmBrep& working; SmFace& face;
    SmPlane* support=nullptr; SmFace* child=nullptr; SmSurface* child_surface=nullptr;
    SmEdge* diagonal=nullptr; Identity diagonal_birth{},child_birth{};
    TransitionReceipt receipt;
    std::array<Slot,4> slots;
    struct OriginalSlot { SmTopology* object=nullptr; SmObject* owner=nullptr; Identity generation{}; };
    std::array<OriginalSlot,13> original_slots{}; unsigned original_count=0,head_restorations=0;
    SmLoop* original_loop=nullptr; std::array<SmLoopuse*,2> original_loopuses{};
    std::array<SmEdgeuse*,2> original_heads{};
    std::array<SmVertex*,4> corners{};
    std::array<SmPoint3d,4> uv{},points{};
    std::unique_ptr<SmBSplineCurve> line3,line2;
    SmBSplineCurve *curve3=nullptr,*curve2=nullptr,*copy_source=nullptr;
    SmObject* pending_birth=nullptr; Identity pending_generation{};
    struct Born { SmObject* object=nullptr; Identity generation{}; long type=0; bool destroyed=false; };
    std::array<Born,24> born{}; unsigned born_count=0;
    SmBSplineCurve* cut_copy=nullptr;
    std::array<SmObject*,7> destroyed_curves{}; unsigned destroyed_curve_count=0;
    unsigned pre_faces=0,pre_edges=0,pre_vertices=0;
    uint64_t parent_frame_serial=0;
    unsigned frame=0,split_events=0,merge_events=0,edge_pre=0,face_pre[2]{};
    unsigned edge_geometry=0,curve_owner=0,surface_owner=0,add_events=0,brep_pre=0,remove_events=0;
    bool expecting_birth=false; double pre_volume=0,pre_area=0,pre_face_volume=0;
    SmExtent2d domain;
    SmBoolean old_rect=FALSE; bool consumed=false,discharged=false;
    std::unique_ptr<RepresentationSeal> source_seal,pre_seal,post_seal;
    PlanarTransition(Ledger&,SmBrep&,SmBrep&,SmFace&);
    void prepare(); void insert(); void erase(); void restore(); void discharge();
    void issue_slot(SmTopology*); void restore_heads(); void verify_slots();
    void check_children(); void numeric_check(bool split);
    void retire_curve(Event&,SmObject*); bool born_object(SmObject*) const;
    SmBSplineCurve* construct_curve(unsigned dimension,const SmPoint3d&,const SmPoint3d&);
    bool event(Event&,SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*);
    uint64_t expected_slot_pointer(const void*) const;
    Identity expected_face_slot(SmFace*,Identity) const;
    void validate_receipt(const TransitionReceipt&,SmBrep&);
    friend class Ledger; friend class RepresentationSeal;
public:
    ~PlanarTransition();
    static TransitionReceipt roundtrip(Ledger&,SmBrep& immutable_source,SmBrep& owned_working,SmFace&);
    static void consume(Ledger&,const TransitionReceipt&,SmBrep& owned_working);
};
}
