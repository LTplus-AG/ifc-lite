// SPDX-License-Identifier: MPL-2.0
// Retained-authored round1: actual capped SDK sweeps, not a transport geometry peer.
#include "ifclite_smlib.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
void run_sweep_region_tests();
void run_disk_tests();
namespace {
void expect(bool ok) { if (!ok) { std::fprintf(stderr,"sweep invariant failed\n"); std::abort(); } }
void ok(int32_t status) { expect(status==0); }
void u32(std::vector<uint8_t>& b,uint32_t v) { for(unsigned i=0;i<4;++i)b.push_back(uint8_t(v>>(i*8))); }
void f64(std::vector<uint8_t>& b,double v) { uint64_t bits;std::memcpy(&bits,&v,8);
    for(unsigned i=0;i<8;++i)b.push_back(uint8_t(bits>>(i*8))); }
std::vector<uint8_t> recipe(bool circle,uint32_t subdivisions=1) {
    const uint32_t count=circle ? 1 : 4*subdivisions;
    std::vector<uint8_t> b;
    for(uint32_t v:{1u,1u,count,0u})u32(b,v);
    for(double v:{0.,0.,1.,3.})f64(b,v);
    u32(b,0);u32(b,count);
    if(circle) {
        u32(b,2);u32(b,0);
        for(double v:{0.,0.,0.,0.,0.,1.,1.,0.,0.,2.,0.,2*3.14159265358979323846})f64(b,v);
    } else {
        const double points[4][2]={{0,0},{2,0},{2,4},{0,4}};
        for(uint32_t edge=0;edge<4;++edge)for(uint32_t i=0;i<subdivisions;++i) {
            double values[12]={};
            for(unsigned j=0;j<2;++j) {
                const double a=points[edge][j], d=points[(edge+1)%4][j]-a;
                values[j]=a+d*i/subdivisions;values[3+j]=a+d*(i+1)/subdivisions;
            }
            u32(b,1);u32(b,0);for(double v:values)f64(b,v);
        }
    }
    return b;
}
ifclite_smlib_handle construct(uint64_t session,const std::vector<uint8_t>& b,uint32_t count) {
    uint64_t token=0;ok(ifclite_smlib_sweep_begin(session,1,b.size(),1,count,&token));
    for(uint32_t offset=0;offset<b.size();) {
        const uint32_t length=std::min(uint32_t(b.size()-offset),3840u);
        ok(ifclite_smlib_sweep_chunk(session,token,offset,b.data()+offset,length));offset+=length;
    }
    ifclite_smlib_handle solid{};ok(ifclite_smlib_sweep_commit(session,token,&solid));return solid;
}
double volume(uint64_t s,ifclite_smlib_handle h) { double v=0;ok(ifclite_smlib_volume(s,h,1e-8,&v));return v; }
}
void run_sweep_tests() {
    run_sweep_region_tests();
    run_disk_tests();
    expect(ifclite_smlib_abi_version()==1 && (ifclite_smlib_capabilities()&1));
    uint64_t session=0;ok(ifclite_smlib_session_create(&session));
    for(bool circle:{false,true}) {
        const auto bytes=recipe(circle);const auto solid=construct(session,bytes,circle?1:4);
        const double expected=circle?12*3.14159265358979323846:24;
        expect(std::abs(volume(session,solid)-expected)<1e-5);
        ifclite_smlib_handle copy{},mesh{};
        ok(ifclite_smlib_boolean(session,solid,solid,IFCLITE_SMLIB_UNION,&copy));
        expect(std::abs(volume(session,solid)-expected)<1e-5);
        ok(ifclite_smlib_tessellate(session,solid,0.001,5,&mesh));
        ifclite_smlib_mesh_info info{};ok(ifclite_smlib_mesh_get_info(session,mesh,&info));
        expect(info.triangle_count>0 && info.source_face_count>0 && !info.failed_faces &&
            !info.boundary_edges && !info.spine_edges);
        ok(ifclite_smlib_release(session,mesh));ok(ifclite_smlib_release(session,copy));
        ok(ifclite_smlib_release(session,solid));
    }
    // An actual SDK solid whose staged input is larger than a request frame.
    const auto large=recipe(false,32);expect(large.size()>4096);
    const auto solid=construct(session,large,128);expect(std::abs(volume(session,solid)-24)<1e-5);
    ok(ifclite_smlib_release(session,solid));
    uint64_t upload=0;const auto bytes=recipe(false);
    ok(ifclite_smlib_sweep_begin(session,1,bytes.size(),1,4,&upload));
    expect(ifclite_smlib_sweep_chunk(session,upload,UINT32_MAX,bytes.data(),1)!=0);
    ifclite_smlib_handle out{99,99,99};expect(ifclite_smlib_sweep_commit(session,upload,&out)!=0);
    expect(out.session==0);
    ok(ifclite_smlib_sweep_begin(session,1,bytes.size(),1,4,&upload));
    expect(ifclite_smlib_sweep_commit(session,upload,&out)!=0); // incomplete consumed
    ok(ifclite_smlib_sweep_begin(session,1,bytes.size(),1,4,&upload));
    expect(ifclite_smlib_sweep_commit(session,upload,nullptr)!=0); // null output leaves token owned
    ok(ifclite_smlib_sweep_abort(session,upload));
    expect(ifclite_smlib_sweep_begin(session,1,UINT32_MAX,1,UINT32_MAX,&upload)!=0);
    expect(ifclite_smlib_sweep_begin(session,1,bytes.size(),129,4,&upload)!=0); // bounded loops
    auto curved=recipe(true);double half=3.14159265358979323846;
    uint64_t bits;std::memcpy(&bits,&half,8);
    for(unsigned i=0;i<8;++i)curved[curved.size()-8+i]=uint8_t(bits>>(i*8));
    ok(ifclite_smlib_sweep_begin(session,1,curved.size(),1,1,&upload));
    ok(ifclite_smlib_sweep_chunk(session,upload,0,curved.data(),curved.size()));
    expect(ifclite_smlib_sweep_commit(session,upload,&out)!=0); // partial arc refused
    ok(ifclite_smlib_session_destroy(session));
}
