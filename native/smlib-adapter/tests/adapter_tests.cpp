// SPDX-License-Identifier: MPL-2.0
// geometric invariants and owned-handle lifetime through the C boundary.
#include "ifclite_smlib.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
extern "C" uint32_t header_works_in_c(void);
void run_empty_tests();
void run_mesh_tests();
void run_affine_tests();
void run_sweep_tests();
namespace {
void expect(bool value, const char* label) {
    if (!value) {
        char error[512]; ifclite_smlib_error_copy(error, sizeof(error));
        std::fprintf(stderr, "FAIL: %s (%s)\n", label, error); std::exit(1);
    }
}
void ok(int32_t status) { expect(status == IFCLITE_SMLIB_OK, "successful C ABI operation"); }
double volume(uint64_t session, ifclite_smlib_handle solid) {
    double result; ok(ifclite_smlib_volume(session, solid, 1e-8, &result)); return result;
}
void near(double actual, double expected) {
    expect(std::abs(actual - expected) < 1e-6, "analytic solid volume");
}
}
int main() {
    run_empty_tests();
    run_mesh_tests();
    run_affine_tests();
    run_sweep_tests();
    expect(header_works_in_c() == 1, "version from pure C translation unit");
    uint64_t session, other;
    ok(ifclite_smlib_session_create(&session)); ok(ifclite_smlib_session_create(&other));
    ifclite_smlib_handle a, b, out;
    ok(ifclite_smlib_box(session, 0,0,0, 2,2,2, &a));
    ok(ifclite_smlib_box(session, 1,0,0, 2,2,2, &b));
    for (int repeat = 0; repeat < 20; ++repeat) {
        for (uint32_t operation = 1; operation <= 3; ++operation) {
            ok(ifclite_smlib_boolean(session, a,b, operation, &out));
            near(volume(session, out), operation == 1 ? 12 : 4);
            uint32_t manifold; ok(ifclite_smlib_manifold(session, out, &manifold));
            expect(manifold == 1, "boolean result is manifold");
            ok(ifclite_smlib_release(session, out));
            near(volume(session, a), 8); near(volume(session, b), 8);
        }
    }
    expect(ifclite_smlib_boolean(session,a,b,99,&out) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "unknown operation rejected");
    expect(out.session == 0, "failure clears result handle");
    char error[5]; const uint32_t bytes = ifclite_smlib_error_copy(error,sizeof(error));
    expect(bytes > sizeof(error) && error[4] == '\0', "bounded copied error text");
    near(volume(session,a),8); near(volume(session,b),8);
    ok(ifclite_smlib_boolean(session,a,a,IFCLITE_SMLIB_UNION,&out));
    near(volume(session,out),8); ok(ifclite_smlib_release(session,out));
    near(volume(session,a),8);
    ok(ifclite_smlib_boolean(session,a,a,IFCLITE_SMLIB_DIFFERENCE,&out));
    near(volume(session,out),0); ok(ifclite_smlib_release(session,out));
    near(volume(session,a),8);
    // A failure after copying left must also preserve the original left operand.
    auto invalid = b; ++invalid.generation;
    expect(ifclite_smlib_boolean(session,a,invalid,1,&out) == IFCLITE_SMLIB_INVALID_HANDLE,
        "transaction rejects stale second operand");
    near(volume(session,a),8); near(volume(session,b),8);
    expect(ifclite_smlib_box(session,0,0,0,-1,2,3,&out) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "negative dimension rejected");
    expect(ifclite_smlib_box(session,0,0,0,0,2,3,&out) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "zero dimension rejected");
    expect(ifclite_smlib_box(session,1e20,0,0,1,1,1,&out) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "box extent lost at absolute origin requires rebase");
    expect(ifclite_smlib_cylinder(session,1e20,0,0,1,1,&out) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "cylinder radius lost at absolute origin requires rebase");
    expect(ifclite_smlib_box(session,1e10,0,0,1,1,1,&out) == IFCLITE_SMLIB_KERNEL_ERROR,
        "numerically degenerate primitive is rejected even with representable endpoints");
    expect(out.session == 0, "failed primitive validation publishes no handle");
    expect(ifclite_smlib_box(session,0,0,0,1e-100,2,3,&out) == IFCLITE_SMLIB_KERNEL_ERROR,
        "upstream rejects below-tolerance dimensions through status boundary");
    near(volume(session,a),8); near(volume(session,b),8);
    expect(ifclite_smlib_cylinder(session,0,0,0,std::numeric_limits<double>::infinity(),1,&out)
        == IFCLITE_SMLIB_INVALID_ARGUMENT, "infinite radius rejected");
    expect(ifclite_smlib_box(session,std::numeric_limits<double>::quiet_NaN(),0,0,1,1,1,&out)
        == IFCLITE_SMLIB_INVALID_ARGUMENT, "NaN origin rejected");
    expect(ifclite_smlib_box(session,0,0,0,1,1,1,nullptr) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "null output rejected");
    double value;
    expect(ifclite_smlib_volume(session,a,1e-12,&value) == IFCLITE_SMLIB_INVALID_ARGUMENT,
        "unsupported integration tolerance rejected without silent clamping");
    expect(ifclite_smlib_volume(other,a,1e-8,&value) == IFCLITE_SMLIB_INVALID_HANDLE,
        "cross-session handle rejected");
    ok(ifclite_smlib_release(session,a));
    ok(ifclite_smlib_box(session,0,0,0,1,1,1,&out));
    expect(out.slot == a.slot && out.generation != a.generation, "reused slot changes generation");
    expect(ifclite_smlib_release(session,a) == IFCLITE_SMLIB_INVALID_HANDLE,
        "stale handle cannot release replacement");
    near(volume(session,out),1);
    ifclite_smlib_handle cylinder;
    ok(ifclite_smlib_cylinder(session,0,0,0,2,3,&cylinder));
    near(volume(session,cylinder),12 * 3.14159265358979323846);
    ok(ifclite_smlib_session_destroy(session));
    expect(ifclite_smlib_volume(session,out,1e-8,&value) == IFCLITE_SMLIB_INVALID_SESSION,
        "destroyed session invalidates all handles");
    ok(ifclite_smlib_session_destroy(other));
    std::puts("SMLib C ABI: volume, manifold, immutable transactions and handle lifetime passed");
}
