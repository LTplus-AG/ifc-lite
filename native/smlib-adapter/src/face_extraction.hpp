// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include <vector>
class SmMerge;
namespace face_lineage {
struct FaceTransfer { Identity source,output; };
// Checked source-direction face copying into an OWNED provisional target.
// This neither intersects nor classifies, selects the opposite cap orientation,
// validates solid closure, publishes a handle, nor certifies a paired output.
// The relation owner and both operands must remain alive through the call.
// On status8 all SDK operands/relations must be abandoned by their isolation
// owner; no later SDK access/destruction is permitted.
std::vector<FaceTransfer> checked_extract_faces(SmBrep& source,SmBrep& target,
    SmMerge& relations,SmFace* const* selected,uint32_t count,Ledger&);
}
