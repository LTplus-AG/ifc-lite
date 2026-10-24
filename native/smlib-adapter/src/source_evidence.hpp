// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include <cstdint>
#include <memory>
#include <vector>
namespace face_lineage {
struct SourceStamp { uint64_t incarnation,epoch,revision; uint32_t entity; };
struct SourceRoot { uint64_t domain,sequence; uint32_t role,ordinal; };
struct SourceInventory {
    ifclite_smlib_handle origin{};
    SourceStamp source{};
    uint64_t operation=0;
    std::vector<SourceRoot> roots;
};
std::vector<uint8_t> source_packet(const SourceInventory&,ifclite_smlib_handle current);
}
