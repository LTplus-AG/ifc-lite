// SPDX-License-Identifier: MPL-2.0
#include "mesh.hpp"
#include "empty.hpp"
#include "mesh_canonical.hpp"
#include "mesh_diagonals.hpp"
#include <SmApiBrep.h>
#include <SmBrep.h>
#include <SmCone.h>
#include <SmPlane.h>
#include <SmPoly.h>
#include <array>
#include <cmath>
#include <stdexcept>
#include <unordered_map>
namespace {
void ensure(bool value, const char* message) { if (!value) throw AdapterMeshFailure{message}; }
void checked(SmStatus status) { ensure(status == SM_SUCCESS,"upstream tessellation/triangulation failed"); }
}
std::unique_ptr<AdapterMesh> tessellate_mesh(SmBrep* solid, double chord, double angle) {
    SmTArray<SmFace*> source_faces; solid->GetFaces(source_faces);
    if (semantically_empty_brep(solid)) {
        ensure(source_faces.GetSize() == 0,"empty solid has source faces");
        return std::make_unique<AdapterMesh>();
    }
    ensure(source_faces.GetSize() > 0,"nonempty solid has no tessellatable faces");
    ensure(source_faces.GetSize() <= 1000000,"source face budget exceeded");
    std::unordered_map<SmFace*,uint32_t> source_ids;
    for (ULONG i = 0; i < source_faces.GetSize(); ++i) source_ids.emplace(source_faces[i],i);
    SmTessellationParams params; params.dChordHeightTol = chord;
    params.dCurveAngleTolDeg = angle; params.dSurfaceAngleTolDeg = angle;
    SmPolyBrep* raw = nullptr; SmTessellationReport report;
    const auto status = SmApiTessellate(solid,raw,params,FALSE,nullptr,&report);
    std::unique_ptr<SmPolyBrep> poly(raw); checked(status);
    ensure(poly && report.failures.GetSize() == 0,"partial tessellation rejected");
    SmTArray<SmPolyFace*> polygons; poly->GetPolyFaces(polygons);
    ensure(polygons.GetSize() <= 1000000,"polygon budget exceeded");
    std::unordered_map<SmPolyFace*,uint32_t> triangle_sources;
    for (auto* polygon : polygons) {
        auto found = source_ids.find(polygon->GetOriginalFace());
        ensure(found != source_ids.end(),"tessellation lost source face attribution");
        const uint32_t source = found->second;
        SmTArray<SmPolyFace*> added;
        if (!polygon->IsTriangle())
            checked(polygon->IsPlanar() ? polygon->TriangulatePlanar(added)
                                       : polygon->TriangulateNonPlanar(added));
        triangle_sources.emplace(polygon,source);
        for (auto* triangle : added) triangle_sources.emplace(triangle,source);
    }
    poly->GetPolyFaces(polygons);
    ensure(polygons.GetSize() <= 1000000,"triangle budget exceeded");
    auto mesh = std::make_unique<AdapterMesh>();
    mesh->info.source_face_count = source_faces.GetSize();
    mesh->info.boundary_edges = poly->GetNumberLaminaPolyEdges();
    mesh->info.spine_edges = poly->GetNumberSpinePolyEdges();
    // Every consumer requires a closed 2-manifold mesh, whatever the input BRep
    // topology. A non-manifold Boolean result is a typed kernel refusal, never
    // a success carrying lamina/spine edges (#7955).
    ensure(!mesh->info.boundary_edges && !mesh->info.spine_edges,
        "solid tessellation has boundary or spine edges");
    std::unordered_map<SmPolyVertex*,uint32_t> vertex_ids;
    for (auto* triangle : polygons) {
        ensure(triangle->IsTriangle(),"upstream triangulator left non-triangle polygon");
        auto source = triangle_sources.find(triangle);
        ensure(source != triangle_sources.end(),"triangulation lost source face attribution");
        SmTArray<SmPolyEdge*> edges; checked(triangle->GetNonDegeneratePolyEdges(edges));
        ensure(edges.GetSize() == 3,"triangle must have three nondegenerate edges");
        std::array<SmPoint3d,3> points;
        for (unsigned corner = 0; corner < 3; ++corner) {
            auto* vertex = edges[corner]->GetStartPolyVertex(); points[corner] = vertex->GetPoint();
            auto point = points[corner];
            ensure(std::isfinite(point.x) && std::isfinite(point.y) && std::isfinite(point.z),
                "nonfinite tessellation vertex");
            auto inserted = vertex_ids.emplace(vertex,uint32_t(vertex_ids.size()));
            if (inserted.second) mesh->positions.insert(mesh->positions.end(),{point.x,point.y,point.z});
            mesh->indices.push_back(inserted.first->second);
        }
        // Degenerate unless some corner's cross product is nonzero, whichever
        // corner the SDK lists first (order_mesh recomputes the normal).
        std::array<double,3> normal{};
        ensure(flat_normal({points[0].x,points[0].y,points[0].z},{points[1].x,points[1].y,points[1].z},
            {points[2].x,points[2].y,points[2].z},normal),"degenerate tessellation triangle");
        for (unsigned corner=0; corner<3; ++corner)
            mesh->normals.insert(mesh->normals.end(),{normal[0],normal[1],normal[2]});
        mesh->faces.push_back(source->second);
    }
    std::vector<std::optional<CylinderPatch>> cylinders(source_faces.GetSize());
    std::vector<bool> planar(source_faces.GetSize());
    for (ULONG i=0;i<source_faces.GetSize();++i) {
        auto* surface=source_faces[i]->GetSurface();
        planar[i]=surface->IsKindOf(SmPlane_TYPE);
        if (!surface->IsKindOf(SmCone_TYPE)) continue;
        CylinderPatch patch; double semi_angle=0;
        if (static_cast<SmCone*>(surface)->GetCanonical(patch.frame,patch.radius,semi_angle)==SM_SUCCESS &&
            semi_angle==0 && std::isfinite(patch.radius) && patch.radius>0) cylinders[i]=patch;
    }
    // The SDK enumerates polygons, vertices and corners in heap-address order,
    // which varies between runs on the same input. Order first, so the
    // cylinder flips walk canonical IDs; then retriangulate planar faces and
    // order again. Positions and source-face IDs are unchanged.
    order_mesh(*mesh);
    normalize_mesh_diagonals(*mesh,angle,chord,cylinders);
    canonical_planar_faces(*mesh,planar);
    order_mesh(*mesh);
    mesh->info.vertex_count = uint32_t(mesh->positions.size()/3);
    mesh->info.triangle_count = uint32_t(mesh->indices.size()/3);
    ensure(mesh->info.vertex_count && mesh->info.triangle_count,"nonempty solid produced empty tessellation");
    return mesh;
}
