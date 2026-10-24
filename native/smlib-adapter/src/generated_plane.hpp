// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
class SmAxis2Placement;
class SmExtent2d;
namespace face_lineage {
// Fixed adapter-owned SDK constructor. No arbitrary mutator/callback argument.
// Returns a pending first-issuance receipt bound to this exact live revision;
// admit_roots checks its retained representation before issuing any roots.
class GeneratedPlane {
public:
    static std::unique_ptr<SmBrep> create(Ledger&,const ObjectRevision&,
        const SmAxis2Placement&,const SmExtent2d&,SmFace*&);
};
}
