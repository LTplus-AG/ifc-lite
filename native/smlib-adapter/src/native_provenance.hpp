// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include "ifclite_smlib.h"
#include <vector>
namespace face_lineage {
// These values NEVER discharge PersistentIfcFaces. A native constructor root
// has no authenticated STEP entity, source revision or mapped occurrence.
// The legacy ABI deliberately exports only revision-local face indices.
enum class UnknownReason { UnobservedConstruction, UnauditedAffine, UnauditedBoolean,
    UnauditedClip, UnobservedTessellation };
// Private diagnostic query. This cannot issue or accept provenance authority.
UnknownReason unavailable_reason(uint64_t session,ifclite_smlib_handle);
enum class Evidence { Unknown, NativeOnly };
struct NativeProvenance {
    Evidence evidence=Evidence::Unknown;
    std::shared_ptr<const void> owner;
    UnknownReason unknown=UnknownReason::UnobservedTessellation;
    // Empty unless an owned continuous observer and exact operation have been
    // checked. Each triangle refers to an immutable native event node.
    std::vector<Identity> triangles;
    bool authenticated_ifc_source() const noexcept { return false; }
};
}
