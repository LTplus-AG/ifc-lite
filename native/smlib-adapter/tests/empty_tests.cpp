// SPDX-License-Identifier: MPL-2.0
// Actual pinned SDK semantic empty certificates. Keep every oracle strict:
// the query and the strict tessellation of the same solid must agree.
#include "ifclite_smlib.h"
#include "empty.hpp"
#include "mesh.hpp"
#include <SmApiPrimitives.h>
#include <SmLine.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <memory>
namespace {
void expect(bool value, const char* label) {
    if (!value) {
        char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"FAIL empty outcome: %s (%s)\n",label,error); std::exit(1);
    }
}
void ok(int32_t value) { expect(value == IFCLITE_SMLIB_OK,"successful C ABI operation"); }
void classify(uint64_t session, ifclite_smlib_handle solid, bool empty) {
    uint32_t value=99; ok(ifclite_smlib_is_empty(session,solid,&value));
    expect(value == uint32_t(empty),"actual solid semantic emptiness");
    ifclite_smlib_handle mesh{};
    ok(ifclite_smlib_tessellate(session,solid,0.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(session,mesh,&info));
    expect(!info.boundary_edges && !info.spine_edges && !info.failed_faces,"strict mesh metadata");
    if (empty) expect(!info.vertex_count && !info.triangle_count && !info.source_face_count,
        "certified empty solid tessellates to all-zero metadata");
    else expect(info.vertex_count && info.triangle_count && info.source_face_count,
        "nonempty solid tessellates to a complete mesh");
    expect(ifclite_smlib_is_empty(session,mesh,&value) == IFCLITE_SMLIB_INVALID_HANDLE,
        "a mesh handle is not a solid");
    ok(ifclite_smlib_release(session,mesh));
}
double solid_volume(uint64_t session, ifclite_smlib_handle solid) {
    double value=0; ok(ifclite_smlib_volume(session,solid,1e-8,&value)); return value;
}
// Raw pinned-SDK regressions: a valid vacant BRep keeps an infinite void
// region and non-null list headers, so IsEmptyModel alone is no certificate.
// Full space, an UNSURE region and wire-only topology are not empty solids.
void topology_certificates() {
    SmBrep* raw=nullptr;
    expect(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS && raw,"raw SDK box");
    std::unique_ptr<SmBrep> box(raw);
    std::unique_ptr<SmBrep> vacant(new (*box->GetContext()) SmBrep());
    expect(!vacant->IsEmptyModel(),"vacant BRep is not IsEmptyModel");
    expect(semantically_empty_brep(vacant.get()),"vacant BRep with void infinite region is empty");
    vacant->GetInfiniteRegion()->SetIsVoid(FALSE);
    expect(!semantically_empty_brep(vacant.get()),"material infinite region is full space");
    vacant->GetInfiniteRegion()->SetIsVoid(UNSURE);
    expect(!semantically_empty_brep(vacant.get()),"UNSURE infinite region is not certified");
    vacant->GetInfiniteRegion()->SetIsVoid(TRUE);
    expect(semantically_empty_brep(vacant.get()),"restored void region is empty");
    expect(!semantically_empty_brep(box.get()),"bounded box is not empty");
    SmEdge* wire_edge=nullptr;
    auto* line=new (*vacant->GetContext()) SmLine(SmPoint3d(0,0,0),SmVector3d(1,0,0));
    expect(vacant->CreateWireEdgeFromCurve(line,SmExtent1d(0,1),wire_edge)==SM_SUCCESS && wire_edge,
        "wire edge in void space");
    expect(!semantically_empty_brep(vacant.get()),"wire topology is not empty");
    bool wire_refused=false;
    try { (void)tessellate_mesh(vacant.get(),0.001,5); }
    catch(const AdapterMeshFailure&) { wire_refused=true; }
    expect(wire_refused,"wire-only BRep has no strict tessellation");
}
}
void run_empty_tests() {
    expect(ifclite_smlib_capabilities() & IFCLITE_SMLIB_CAPABILITY_SEMANTIC_EMPTY,
        "semantic empty capability");
    uint64_t session; ok(ifclite_smlib_session_create(&session));
    topology_certificates();
    ifclite_smlib_handle a{}, b{}, empty{}, removed{};
    ok(ifclite_smlib_box(session,0,0,0,2,2,2,&a));
    ok(ifclite_smlib_box(session,10,0,0,2,2,2,&b));
    ok(ifclite_smlib_boolean(session,a,b,IFCLITE_SMLIB_INTERSECTION,&empty));
    ok(ifclite_smlib_boolean(session,a,a,IFCLITE_SMLIB_DIFFERENCE,&removed));
    classify(session,empty,true); classify(session,removed,true);
    // Copying an empty solid (as a relative right operand is) stays empty.
    const double shift[16]={1,0,0,0, 0,1,0,0, 0,0,1,0, 5,0,0,1};
    ifclite_smlib_handle moved{};
    ok(ifclite_smlib_transform(session,empty,shift,&moved));
    classify(session,moved,true); ok(ifclite_smlib_release(session,moved));
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
                if (!expected) expect(std::abs(solid_volume(session,result)-8)<1e-6,
                    "empty identity preserves nonempty geometry");
                ok(ifclite_smlib_release(session,result));
                classify(session,a,false); classify(session,zero,true);
            }
        }
    }
    ok(ifclite_smlib_release(session,empty)); ok(ifclite_smlib_release(session,removed));
    classify(session,a,false); classify(session,b,false);
    expect(std::abs(solid_volume(session,a)-8)<1e-6 && std::abs(solid_volume(session,b)-8)<1e-6,
        "operands unchanged by every empty identity");
    uint32_t value=99;
    expect(ifclite_smlib_is_empty(session,empty,&value)==IFCLITE_SMLIB_INVALID_HANDLE,
        "released solid has no certificate");
    expect(ifclite_smlib_is_empty(session,a,nullptr)==IFCLITE_SMLIB_INVALID_ARGUMENT,
        "null query output");
    ok(ifclite_smlib_session_destroy(session));
    std::fputs("SMLib semantic empty: topology certificates and Boolean identities passed\n",stderr);
}
