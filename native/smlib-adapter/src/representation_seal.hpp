// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include <vector>
class SmPoint3d;
namespace face_lineage {
// Retained exact boundary-state evidence, never certificate authority. Only
// adapter-exclusive graphs and audited entrypoints may use this private seam.
// No arbitrary callback/SDK function can be supplied for execution here.
class RepresentationSeal {
    Ledger& ledger;
    SmBrep& source;
    Identity operation;
    bool initial=false;
    const class PlanarTransition* transition_slots=nullptr;
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
    // Exact represented numerical equality, excluding ONLY the owner pointer.
    // These checks issue no roots or general numerical/domain certificate.
    void require_exact_curve_copy(SmObject*,SmObject*);
    void require_exact_surface_copy(SmObject*,SmObject*);
private:
    RepresentationSeal(Ledger&,SmBrep&,bool initial_creation);
    friend class GeneratedPlane;
    friend class PlanarTransition;
};
struct BoundaryProperties { double area=0,volume=0; };
// Fixed calls only. No callable, external mutator or user phase flag.
class NumericalRead {
    static void begin(Ledger&,SmBrep&);
    static void end(Ledger&);
public:
    static double volume(Ledger&,SmBrep&,double accuracy);
    static BoundaryProperties face(Ledger&,SmFace&,SmOrientType,double accuracy,
        const SmPoint3d& origin,double estimated_area);
};
}
