// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include "mesh.hpp"
#include <memory>
namespace face_lineage {
// Private native owner, not the public IFC/source-controller contract. No raw
// BRep escapes this owner, and there is no adopt-arbitrary-result entrypoint.
class OwnedBoundary {
    struct State {
        Ledger ledger;
        Scope observation;
        explicit State(SmContext&);
    };
    // Test-only friend reads actual source geometry and scalar ledger evidence;
    // no public raw-BRep accessor or adoption capability.
    friend struct OwnedBoundaryTestAccess;
    void require_live() const;
    std::shared_ptr<State> state;
    std::unique_ptr<SmBrep> solid;
    OwnedBoundary(std::shared_ptr<State>,std::unique_ptr<SmBrep>);
public:
    ~OwnedBoundary();
    OwnedBoundary(OwnedBoundary&&) noexcept;
    OwnedBoundary& operator=(OwnedBoundary&&)=delete;
    OwnedBoundary(const OwnedBoundary&)=delete;
    static OwnedBoundary box(double width,double depth,double height);
    OwnedBoundary copy() const;
    std::vector<Identity> faces() const;
    std::vector<Root> ancestors(Identity) const;
    std::unique_ptr<AdapterMesh> tessellate(double chord,double angle) const;
    // Missing audited numerical transitions refuse BEFORE invoking the SDK.
    // Never silently turn an incomplete result into fresh constructor roots.
    OwnedBoundary affine(const double* matrix) const;
    OwnedBoundary boolean(const OwnedBoundary&,uint32_t operation) const;
    OwnedBoundary clip(const double* plane,int32_t side,uint32_t mode) const;
};
}
