// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
#include <SmRegion.h>

// IsEmptyModel tests null list headers, which even a newly constructed, vacant
// SDK BRep does not have. Certify absence of material from actual topology:
// no boundary or lower-dimensional geometry, and only known-void regions.
// In particular, a boundary-free material infinite region is full space.
inline bool semantically_empty_brep(const SmBrep* solid) {
    if (solid->IsEmptyModel()) return true;
    SmTArray<SmFace*> faces; solid->GetFaces(faces);
    SmTArray<SmEdge*> edges; solid->GetEdges(edges);
    SmTArray<SmVertex*> vertices; solid->GetVertices(vertices);
    SmTArray<SmShell*> shells; solid->GetShells(shells);
    if (faces.GetSize() || edges.GetSize() || vertices.GetSize() || shells.GetSize()) return false;
    const auto* infinite=solid->GetInfiniteRegion();
    if (!infinite || infinite->IsVoid()!=TRUE) return false;
    SmTArray<SmRegion*> regions; solid->GetRegions(regions);
    bool owns_infinite=false;
    for (const auto* region:regions) {
        if (!region || region->IsVoid()!=TRUE) return false;
        owns_infinite |= region==infinite;
    }
    return owns_infinite;
}
