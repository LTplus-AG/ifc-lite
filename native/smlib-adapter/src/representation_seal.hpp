// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include <vector>
namespace face_lineage {
// Retained exact boundary-state evidence, never certificate authority. Only
// adapter-exclusive graphs and audited entrypoints may use this private seam.
// No arbitrary callback/SDK function can be supplied for execution here.
class RepresentationSeal {
    Ledger& ledger;
    SmBrep& source;
    Identity operation;
    std::vector<uint64_t> retained,scratch;
    std::vector<SmObject*> pending;
    uint32_t work=0;
    void word(uint64_t);
    void real(double);
    void pointer(const void*);
    void object(SmObject*);
    void curve(SmObject*);
    void surface(SmObject*);
    void capture();
public:
    RepresentationSeal(Ledger&,SmBrep&);
    RepresentationSeal(const RepresentationSeal&)=delete;
    RepresentationSeal& operator=(const RepresentationSeal&)=delete;
    void verify();
};
}
