// SPDX-License-Identifier: MPL-2.0
// P2 actual pinned SDK semantic empty certificates; UNRUN until SDK execution.
#include "ifclite_smlib.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
namespace {
void expect(bool value) {
    if (!value) {
        char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"empty outcome invariant failed: %s\n",error); std::exit(1);
    }
}
void ok(int32_t value) { expect(value == IFCLITE_SMLIB_OK); }
void classify(uint64_t session, ifclite_smlib_handle solid, bool empty) {
    uint32_t value=99; ok(ifclite_smlib_is_empty(session,solid,&value));
    expect(value == uint32_t(empty));
    ifclite_smlib_handle mesh{};
    ok(ifclite_smlib_tessellate(session,solid,0.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(session,mesh,&info));
    expect(!info.boundary_edges && !info.spine_edges && !info.failed_faces);
    if (empty) expect(!info.vertex_count && !info.triangle_count && !info.source_face_count);
    else expect(info.vertex_count && info.triangle_count && info.source_face_count);
    expect(ifclite_smlib_is_empty(session,mesh,&value) == IFCLITE_SMLIB_INVALID_HANDLE);
    ok(ifclite_smlib_release(session,mesh));
}
}
void run_empty_tests() {
    expect(ifclite_smlib_capabilities() & 32u);
    uint64_t session; ok(ifclite_smlib_session_create(&session));
    ifclite_smlib_handle a{}, b{}, empty{}, removed{};
    ok(ifclite_smlib_box(session,0,0,0,2,2,2,&a));
    ok(ifclite_smlib_box(session,10,0,0,2,2,2,&b));
    ok(ifclite_smlib_boolean(session,a,b,IFCLITE_SMLIB_INTERSECTION,&empty));
    ok(ifclite_smlib_boolean(session,a,a,IFCLITE_SMLIB_DIFFERENCE,&removed));
    classify(session,empty,true); classify(session,removed,true);
    for (uint32_t operation=1; operation<=3; ++operation) {
        ifclite_smlib_handle result{};
        ok(ifclite_smlib_boolean(session,empty,removed,operation,&result));
        classify(session,result,true); ok(ifclite_smlib_release(session,result));
    }
    for (auto zero : {empty,removed}) {
        for (uint32_t operation=1; operation<=3; ++operation) {
            for (bool reverse : {false,true}) {
                ifclite_smlib_handle result{};
                ok(ifclite_smlib_boolean(session,reverse ? a : zero,reverse ? zero : a,operation,&result));
                const bool expected=operation==IFCLITE_SMLIB_INTERSECTION ||
                    (operation==IFCLITE_SMLIB_DIFFERENCE && !reverse);
                classify(session,result,expected);
                if (!expected) {
                    double volume=0; ok(ifclite_smlib_volume(session,result,1e-8,&volume));
                    expect(std::abs(volume-8)<1e-6);
                }
                ok(ifclite_smlib_release(session,result));
                classify(session,a,false); classify(session,zero,true);
            }
        }
    }
    ok(ifclite_smlib_release(session,empty)); ok(ifclite_smlib_release(session,removed));
    classify(session,a,false); classify(session,b,false);
    uint32_t value=99;
    expect(ifclite_smlib_is_empty(session,empty,&value)==IFCLITE_SMLIB_INVALID_HANDLE);
    expect(ifclite_smlib_is_empty(session,a,nullptr)==IFCLITE_SMLIB_INVALID_ARGUMENT);
    ok(ifclite_smlib_session_destroy(session));
}
