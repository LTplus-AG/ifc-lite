// SPDX-License-Identifier: MPL-2.0
#include "mesh.hpp"
#include "empty.hpp"
#include "representation_seal.hpp"
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
std::unique_ptr<AdapterMesh> tessellate_mesh(SmBrep* solid, double chord, double angle, face_lineage::Ledger* lineage) {
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
    const auto status = lineage
        ? face_lineage::NumericalRead::tessellate(*lineage,*solid,raw,params,report)
        : SmApiTessellate(solid,raw,params,FALSE,nullptr,&report);
    std::unique_ptr<SmPolyBrep> poly(raw); checked(status);
    ensure(poly && report.failures.GetSize() == 0,"partial tessellation rejected");
    SmTArray<SmPolyFace*> polygons; poly->GetPolyFaces(polygons);
    ensure(polygons.GetSize() <= 1000000,"polygon budget exceeded");
    std::unordered_map<SmPolyFace*,uint32_t> triangle_sources;
    std::unordered_map<SmPolyFace*,face_lineage::Identity> triangle_lineage;
    // Snapshot before triangulation: newly inserted diagonal edges need not
    // carry SDK aux data. Identity is local to ONE parent polygon, never a
    // spatial nearest-triangle match or an average across source faces/seams.
    using CornerMap = std::unordered_map<SmPolyVertex*,SmVector3d>;
    std::unordered_map<SmPolyFace*,std::shared_ptr<CornerMap>> triangle_normals;
    size_t normal_count=0;
    for (auto* polygon : polygons) {
        auto found = source_ids.find(polygon->GetOriginalFace());
        ensure(found != source_ids.end(),"tessellation lost source face attribution");
        const uint32_t source = found->second;
        const auto identity=lineage?lineage->identity(polygon->GetOriginalFace()):face_lineage::Identity{};
        auto normals=std::make_shared<CornerMap>();
        SmTArray<SmPolyEdge*> corners; checked(polygon->GetNonDegeneratePolyEdges(corners));
        normal_count += corners.GetSize();
        ensure(normal_count <= 3000000,"source corner normal budget exceeded");
        for(auto* edge:corners) {
            auto* aux=edge->GetAuxData();
            ensure(aux,"missing source surface corner normal");
            const auto n=aux->m_vNormal;
            const double size=std::hypot(n.x,n.y,n.z);
            ensure(std::isfinite(size) && std::abs(size-1)<=1e-8,
                "source surface normal must be finite nonzero unit length");
            auto inserted=normals->emplace(edge->GetStartPolyVertex(),n);
            if(!inserted.second) {
                const auto previous=inserted.first->second;
                ensure(std::hypot(n.x-previous.x,n.y-previous.y,n.z-previous.z)<=1e-10,
                    "ambiguous source seam corner normal");
            }
        }
        SmTArray<SmPolyFace*> added;
        if (!polygon->IsTriangle()) {
            checked(polygon->IsPlanar() ? polygon->TriangulatePlanar(added)
                                       : polygon->TriangulateNonPlanar(added));
        }
        if(lineage) triangle_lineage.emplace(polygon,identity);
        triangle_sources.emplace(polygon,source);
        triangle_normals.emplace(polygon,normals);
        for (auto* triangle : added) {
            triangle_sources.emplace(triangle,source);
            if(lineage) triangle_lineage.emplace(triangle,identity);
            triangle_normals.emplace(triangle,normals);
        }
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
        const auto& source_normals=*triangle_normals.at(triangle);
        for (unsigned corner=0; corner<3; ++corner) {
            const auto found=source_normals.find(edges[corner]->GetStartPolyVertex());
            ensure(found!=source_normals.end(),"triangulation lost source corner correspondence");
            const auto n=found->second;
            // SDK OutputFacePolygons evaluates the source surface at its UV
            // vertex and applies bReverse. Never flip a normal to hide a bad
            // source orientation, and never replace it with this cross product.
            ensure(n.x*(nx/length)+n.y*(ny/length)+n.z*(nz/length)>0,
                "source normal disagrees with triangle orientation");
            mesh->normals.insert(mesh->normals.end(),{n.x,n.y,n.z});
        }
        mesh->faces.push_back(source->second);
        if(lineage) mesh->provenance.triangles.push_back(triangle_lineage.at(triangle));
    }
    mesh->info.vertex_count = uint32_t(mesh->positions.size()/3);
    mesh->info.triangle_count = uint32_t(mesh->indices.size()/3);
    ensure(mesh->info.vertex_count && mesh->info.triangle_count,"nonempty solid produced empty tessellation");
    if(lineage) { lineage->check(); mesh->provenance.evidence=face_lineage::Evidence::NativeOnly; }
    return mesh;
}
