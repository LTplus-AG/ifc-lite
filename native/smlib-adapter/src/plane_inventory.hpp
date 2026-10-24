// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <cstdint>
#include <vector>
class SmBrep;
class SmCopyBrepMap;
// Exact, bounded geometry/topology and explicit evaluator-policy values, not
// a full SDK object/cache snapshot or a collision-prone hash. Map topology back
// to source identities only during checked copying; never retain SDK maps.
// Core excludes UV metadata/trims, which explicit reconstruction may change.
std::vector<uint64_t> plane_inventory(SmBrep*,bool include_uv,SmCopyBrepMap* =nullptr);
