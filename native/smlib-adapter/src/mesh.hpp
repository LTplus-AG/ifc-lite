// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include "native_provenance.hpp"
#include "source_evidence.hpp"
#include <memory>
#include <vector>
class SmBrep;
struct AdapterMeshFailure { const char* message; };
struct AdapterMesh {
    ifclite_smlib_mesh_info info{};
    face_lineage::NativeProvenance provenance{};
    std::shared_ptr<const face_lineage::SourceInventory> source_inventory;
    std::vector<uint32_t> source_roots;
    std::vector<double> positions, normals;
    std::vector<uint32_t> indices, faces;
};
std::unique_ptr<AdapterMesh> tessellate_mesh(SmBrep* solid, double chord, double angle, face_lineage::Ledger* lineage=nullptr);
