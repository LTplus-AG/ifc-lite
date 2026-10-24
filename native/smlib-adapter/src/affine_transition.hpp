// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "affine.hpp"
#include "face_lineage.hpp"
#include "representation_seal.hpp"
#include <SmFace.h>
#include <SmVertex.h>
#include <SmOwningTopology.h>
#include <map>
namespace face_lineage {
// No public constructor, mutator, callback or receipt-adoption API. Only the
// checked production affine helper can issue this prescribed transition.
class AffineTransition {
    struct Face { SmFace* object; Identity before; std::vector<Root> roots; };
    struct Link {
        SmObject *owner=nullptr,*expected_owner=nullptr;
        SmTopology *next=nullptr,*last=nullptr,*expected_next=nullptr,*expected_last=nullptr;
        SmTopology *head=nullptr,*expected_head=nullptr;
        std::vector<SmTopology*> children,expected_children;
        SmEdgeuse *radial=nullptr,*expected_radial=nullptr;
        SmPoint3d point,expected_point,magnitude;
        SmBoolean rectangular=UNSURE,expected_rectangular=UNSURE;
    };
    struct Controls { std::vector<double> original,expected,magnitude; unsigned dimension=3; };
    struct ExpectedEvent { SmNotifyOperation op; SmObject *caller,*a,*b,*c; };
    Ledger& ledger; SmBrep& source; SmBrep& working;
    Identity operation{},generation{}; unsigned frame=0,receipts=0;
    std::vector<Face> faces;
    std::vector<SmObject*> objects;
    std::vector<SmTopology*> topology_order;
    std::map<SmTopology*,Link> links;
    std::map<SmObject*,Controls> controls;
    std::vector<std::unique_ptr<RepresentationSeal>> protected_seals;
    std::unique_ptr<RepresentationSeal> seal;
    std::vector<ExpectedEvent> expected_events; size_t position=0;
    AffineTransition(Ledger&,SmBrep&,SmBrep&,const SmCopyBrepMap&);
    static std::vector<std::unique_ptr<RepresentationSeal>> protect(Ledger&,SmBrep* excluded=nullptr);
    void capture(); void predict(const SmAxis2Placement&,const SmVector3d*);
    void reflect(); void materialize_links();
    void expect(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject* =nullptr);
    void plan_events(const SmAxis2Placement&,const SmVector3d*);
    void convert(); void place(const SmAxis2Placement&,const SmVector3d*); void finish();
    void prepare_place(const SmAxis2Placement&,const SmVector3d*); void complete_place();
    void verify_target(); void verify_protected(); void verify_receipt();
    bool event(Event&,SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*);
    // Exact seal projection is closed over the captured physical graph. Only
    // checked transformed coordinates and prescribed reflection slots project.
    void order_topology(SmTArray<SmTopology*>&) const;
    SmObject* owner(SmTopology*) const; SmTopology* next(SmTopology*) const;
    SmTopology* last(SmTopology*) const; SmTopology* head(SmTopology*) const;
    SmEdgeuse* radial(SmEdgeuse*) const; SmBoolean rectangular(SmFace*) const;
    SmPoint3d vertex(SmVertex*) const;
    double control(SmObject*,size_t,double) const;
    friend class Ledger; friend class RepresentationSeal;
    friend struct AffineTransitionTestAccess;
    friend auto ::copy_affine_rational(SmBrep*,const double*,ifclite_smlib_affine_certificate&,face_lineage::Ledger*) -> std::unique_ptr<SmBrep>;
};
}
