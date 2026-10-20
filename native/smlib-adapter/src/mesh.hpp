// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include <memory>
#include <vector>
class SmBrep;
struct AdapterMeshFailure { const char* message; };
struct AdapterMesh {
    ifclite_smlib_mesh_info info{};
    std::vector<double> positions, normals;
    std::vector<uint32_t> indices, faces;
};
std::unique_ptr<AdapterMesh> tessellate_mesh(SmBrep* solid, double chord, double angle);
