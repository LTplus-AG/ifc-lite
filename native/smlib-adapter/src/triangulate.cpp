// SPDX-License-Identifier: MPL-2.0
#include "triangulate.hpp"
#include <cmath>

namespace {
// Both diagonals must lie inside their endpoint sectors. This deliberately
// excludes concave/degenerate quads; the SDK handles those and polygons with
// holes. No projected frame, coordinate rounding or extra tolerance is used.
bool convex_quad(SmPolyFace* polygon, SmTArray<SmPolyEdge*>& edges) {
    SmTArray<SmPolyLoop*> loops; polygon->GetPolyLoops(loops);
    if (loops.GetSize() != 1 || polygon->GetNonDegeneratePolyEdges(edges) != SM_SUCCESS ||
        edges.GetSize() != 4) return false;
    polygon->GetNormal(TRUE,FALSE);
    for (unsigned i=0; i<4; ++i) {
        auto* vertex=edges[i]->GetStartPolyVertex();
        auto* opposite=edges[(i+2)%4]->GetStartPolyVertex();
        SmPolyEdge* sector=nullptr;
        if (polygon->FindVertexSector(vertex,opposite->GetPoint()-vertex->GetPoint(),
                TRUE,sector) != SM_SUCCESS || sector != edges[i]) return false;
        SmTArray<SmPolyEdge*> incident; vertex->GetPolyEdges(incident);
        for (auto* edge : incident)
            if (edge->GetEndPolyVertex() == opposite) return false;
    }
    return true;
}
}

SmStatus triangulate_polygon(SmPolyFace* polygon, SmTArray<SmPolyFace*>& added) {
    if (polygon->IsTriangle()) return SM_SUCCESS;
    SmTArray<SmPolyEdge*> edges;
    if (convex_quad(polygon,edges)) {
        const double a=edges[0]->GetStartPoint().DistanceBetweenSquared(edges[2]->GetStartPoint());
        const double b=edges[1]->GetStartPoint().DistanceBetweenSquared(edges[3]->GetStartPoint());
        if (std::isfinite(a) && std::isfinite(b) && a > 0 && b > 0 && a != b) {
            // #7955: FindSplitLine's aspect-ratio ranking chose opposite
            // diagonals on native/WASM for a warped cylindrical cap quad.
            // Use the shorter diagonal, independently of loop start/winding.
            // Equal lengths retain the SDK policy; no epsilon changes a tie.
            const unsigned start=a < b ? 0 : 1;
            SmPolyEdge* diagonal=nullptr; SmPolyLoop* loop=nullptr; SmPolyFace* face=nullptr;
            const auto status=polygon->MakeManifoldEdge(edges[start],edges[start+2],
                diagonal,loop,face);
            if (status != SM_SUCCESS) return status;
            if (!face || !polygon->IsTriangle() || !face->IsTriangle()) return SM_ERR;
            polygon->GetNormal(TRUE,FALSE); face->GetNormal(TRUE,FALSE);
            added.Add(face);
            return SM_SUCCESS;
        }
    }
    return polygon->IsPlanar() ? polygon->TriangulatePlanar(added)
                               : polygon->TriangulateNonPlanar(added);
}
