// SPDX-License-Identifier: MPL-2.0
// Geometry platform: known geometric invariants, identical code on native and wasm32.
#include <SmApiBrep.h>
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <SmPoly.h>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {
using Brep = std::unique_ptr<SmBrep>;
constexpr double pi = 3.14159265358979323846;

void checked(SmApiStatus status, const char* operation) {
    if (status != SM_SUCCESS) {
        throw std::runtime_error(std::string(operation) + ": status " + std::to_string(status));
    }
}

Brep box(double x, double y, double z, double a, double b, double c) {
    SmBrep* result = nullptr;
    checked(SmApiCreateBox(SmVector3d(x, y, z), a, b, c, result), "box");
    if (!result) throw std::runtime_error("box returned null");
    return Brep(result);
}

Brep cylinder(double x, double y, double z, double radius, double height) {
    SmBrep* result = nullptr;
    checked(SmApiCreateCylinder(SmVector3d(x, y, z), radius, height, result), "cylinder");
    if (!result) throw std::runtime_error("cylinder returned null");
    return Brep(result);
}

Brep combine(Brep left, Brep right, SmBooleanOperationType operation) {
    SmBrep* result = nullptr;
    // On failure both inputs remain allocated; on success result aliases left,
    // and the kernel deletes right. Transfer only after checking the status.
    checked(SmApiBoolean(left.get(), right.get(), operation, result), "boolean");
    right.release();
    if (result != left.get()) throw std::runtime_error("unexpected boolean ownership");
    return left;
}

void record(std::ostringstream& out, const char* name, Brep shape, double expected, bool& passed) {
    double volume = 0;
    checked(SmApiBrepComputeVolume(shape.get(), 1e-8, volume), "volume");
    SmBoolean manifold = FALSE;
    checked(SmApiBrepIsManifoldSolid(shape.get(), manifold), "manifold");
    SmTessellationParams params;
    params.dChordHeightTol = 0.001;
    params.dCurveAngleTolDeg = 15;
    params.dSurfaceAngleTolDeg = 15;
    SmTessellationReport report;
    SmPolyBrep* raw = nullptr;
    const auto status = SmApiTessellate(shape.get(), raw, params, FALSE, nullptr, &report);
    std::unique_ptr<SmPolyBrep> mesh(raw);
    checked(status, "tessellate");
    if (!mesh) throw std::runtime_error("tessellate returned null");
    SmTArray<SmPolyFace*> faces;
    SmTArray<SmPolyVertex*> vertices;
    if (mesh) {
        mesh->GetPolyFaces(faces);
        mesh->GetPolyVertices(vertices);
    }
    const double error = std::abs(volume - expected);
    const bool ok = std::isfinite(volume) && error <= std::max(1e-7, expected * 1e-5)
        && manifold && mesh && faces.GetSize() && vertices.GetSize()
        && report.failures.GetSize() == 0
        && mesh->GetNumberLaminaPolyEdges() == 0 && mesh->GetNumberSpinePolyEdges() == 0;
    passed = passed && ok;
    out << "{\"case\":\"" << name << "\",\"expected_volume\":" << expected
        << ",\"volume\":" << volume << ",\"volume_error\":" << error
        << ",\"brep_manifold\":" << (manifold ? "true" : "false")
        << ",\"polygons\":" << faces.GetSize() << ",\"vertices\":" << vertices.GetSize()
        << ",\"failed_faces\":" << report.failures.GetSize()
        << ",\"boundary_edges\":" << mesh->GetNumberLaminaPolyEdges()
        << ",\"spine_edges\":" << mesh->GetNumberSpinePolyEdges()
        << ",\"passed\":" << (ok ? "true" : "false") << "}";
}

std::string evaluate() {
    SmApiCreateContext();
    bool passed = true;
    std::ostringstream out;
    out << std::setprecision(17) << "{\"cases\":[";
    record(out, "box", box(0, 0, 0, 10, 2, 3), 60, passed);
    out << ',';
    record(out, "rectangular_opening", combine(box(0, 0, 0, 10, 2, 3),
        box(2, -1, 1, 2, 4, 1), SM_BO_DIFFERENCE), 56, passed);
    out << ',';
    record(out, "circular_through_hole", combine(box(0, 0, 0, 10, 4, 3),
        cylinder(5, 2, -1, 0.5, 5), SM_BO_DIFFERENCE), 120 - pi * 0.25 * 3, passed);
    out << ',';
    auto overlapping = combine(box(0, 0, 0, 10, 2, 3),
        box(2, -1, 1, 3, 4, 1), SM_BO_DIFFERENCE);
    record(out, "overlapping_openings", combine(std::move(overlapping),
        box(4, -1, 1, 3, 4, 1), SM_BO_DIFFERENCE), 50, passed);
    out << ',';
    record(out, "disjoint_subtraction", combine(box(0, 0, 0, 10, 2, 3),
        box(20, 0, 0, 1, 1, 1), SM_BO_DIFFERENCE), 60, passed);
    out << ',';
    record(out, "box_union", combine(box(0, 0, 0, 2, 2, 2),
        box(1, 0, 0, 2, 2, 2), SM_BO_UNION), 12, passed);
    out << ',';
    record(out, "box_intersection", combine(box(0, 0, 0, 2, 2, 2),
        box(1, 0, 0, 2, 2, 2), SM_BO_INTERSECTION), 4, passed);
    out << ',';
    auto nurbs = cylinder(5, 2, -1, 0.5, 5);
    checked(SmApiTurnToNurbs(nurbs.get()), "turn_to_nurbs");
    record(out, "nurbs_through_hole", combine(box(0, 0, 0, 10, 4, 3),
        std::move(nurbs), SM_BO_DIFFERENCE), 120 - pi * 0.25 * 3, passed);
    out << ',';
    record(out, "survey_coordinate_opening", combine(box(5000000, 0, 0, 10, 2, 3),
        box(5000002, -1, 1, 2, 4, 1), SM_BO_DIFFERENCE), 56, passed);
    out << ',';
    record(out, "thin_wall_opening", combine(box(0, 0, 0, 10, 0.01, 3),
        box(2, -1, 1, 2, 2, 1), SM_BO_DIFFERENCE), 0.28, passed);
    out << "],\"passed\":" << (passed ? "true" : "false") << "}";
    return out.str();
}
}

extern "C" const char* run_probe() {
    static std::string result;
    try {
        result = evaluate();
    } catch (const std::exception& error) {
        std::cerr << "SMLib probe failed: " << error.what() << '\n';
        result = "{\"passed\":false,\"error\":\"kernel operation failed; inspect stderr\"}";
    }
    return result.c_str();
}

#ifndef __EMSCRIPTEN__
int main() {
    const std::string result = run_probe();
    std::cout << result << '\n';
    return result.find("\"passed\":false") == std::string::npos ? 0 : 1;
}
#endif
