// SPDX-License-Identifier: MPL-2.0
#include "mesh.hpp"
#include <SmApiBrep.h>
#include <SmBrep.h>
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
    if (solid->IsEmptyModel()) {
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
        if (!polygon->IsTriangle()) {
            checked(polygon->IsPlanar() ? polygon->TriangulatePlanar(added)
                                       : polygon->TriangulateNonPlanar(added));
        }
        triangle_sources.emplace(polygon,source);
        for (auto* triangle : added) triangle_sources.emplace(triangle,source);
    }
    poly->GetPolyFaces(polygons);
    ensure(polygons.GetSize() <= 1000000,"triangle budget exceeded");
    auto mesh = std::make_unique<AdapterMesh>();
    mesh->info.source_face_count = source_faces.GetSize();
    mesh->info.boundary_edges = poly->GetNumberLaminaPolyEdges();
    mesh->info.spine_edges = poly->GetNumberSpinePolyEdges();
    ensure(!report.inputManifold || (!mesh->info.boundary_edges && !mesh->info.spine_edges),
        "manifold solid tessellation has boundary or spine edges");
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
        const double ux=points[1].x-points[0].x, uy=points[1].y-points[0].y, uz=points[1].z-points[0].z;
        const double vx=points[2].x-points[0].x, vy=points[2].y-points[0].y, vz=points[2].z-points[0].z;
        const double nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
        const double length=std::hypot(nx,ny,nz);
        ensure(std::isfinite(length) && length > 0,"degenerate tessellation triangle");
        for (unsigned corner=0; corner<3; ++corner)
            mesh->normals.insert(mesh->normals.end(),{nx/length,ny/length,nz/length});
        mesh->faces.push_back(source->second);
    }
    mesh->info.vertex_count = uint32_t(mesh->positions.size()/3);
    mesh->info.triangle_count = uint32_t(mesh->indices.size()/3);
    ensure(mesh->info.vertex_count && mesh->info.triangle_count,"nonempty solid produced empty tessellation");
    return mesh;
}
