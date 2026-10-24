// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "owned_lineage.hpp"
#include <SmBrep.h>
namespace face_lineage {
// Only test translation units define this friend. No runtime adoption API.
struct OwnedBoundaryTestAccess {
    static const SmBrep& solid(const OwnedBoundary& owner) { return *owner.solid; }
    static const Ledger& ledger(const OwnedBoundary& owner) { return owner.state->ledger; }
};
}
