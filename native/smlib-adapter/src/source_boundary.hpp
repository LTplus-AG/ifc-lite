// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "source_evidence.hpp"
#include "face_lineage.hpp"
#include "mesh.hpp"
namespace face_lineage {
// Production native owner used by retained dispatch. No arbitrary BRep adoption.
class SourceBoundary {
    struct State {
        std::unique_ptr<SmContext> context;
        Ledger ledger;
        std::unique_ptr<Scope> observation;
        std::shared_ptr<SourceInventory> inventory;
        State();~State();
    };
    std::shared_ptr<State> state;
    std::unique_ptr<SmBrep> solid;
    SourceBoundary(std::shared_ptr<State>,std::unique_ptr<SmBrep>);
    void live() const;
public:
    ~SourceBoundary();
    static std::unique_ptr<SourceBoundary> construct(const std::vector<uint8_t>&,uint32_t loops,uint32_t segments,
        SourceStamp,ifclite_smlib_handle,uint64_t operation);
    std::unique_ptr<SourceBoundary> affine(const double*,ifclite_smlib_affine_certificate&) const;
    std::unique_ptr<AdapterMesh> tessellate(double,double) const;
    const SourceInventory& inventory() const;
};
}
