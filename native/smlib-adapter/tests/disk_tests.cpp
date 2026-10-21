// SPDX-License-Identifier: MPL-2.0
// Actual rational pipe construction and immutable rigid transform witnesses.
#include "ifclite_smlib.h"
#include "sweep.hpp"
#include <SmApiQueries.h>
#include <cmath>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>
namespace {
constexpr double pi=3.14159265358979323846;
void expect_at(bool v,const char* expression,int line) {
    if(!v) {
        char error[512];ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"disk/transform witness failed line=%d expression=%s error=%s\n",line,expression,error);
        std::abort();
    }
}
#define expect(value) expect_at((value),#value,__LINE__)
#define ok(status) expect((status)==0)
void u32(std::vector<uint8_t>& b,uint32_t v) { for(unsigned j=0;j<4;++j)b.push_back(uint8_t(v>>(8*j))); }
void f64(std::vector<uint8_t>& b,double v) { uint64_t bits;std::memcpy(&bits,&v,8);
    for(unsigned j=0;j<8;++j)b.push_back(uint8_t(bits>>(8*j))); }
std::vector<uint8_t> recipe(bool curved) {
    std::vector<uint8_t> b;
    for(uint32_t v:{2u,1u,1u,0u})u32(b,v);
    f64(b,0.25);f64(b,0);
    for(uint32_t v:{4u,0u,curved?2u:1u,curved?3u:2u,2u,0u})u32(b,v);
    f64(b,0);f64(b,1);
    if(curved) {
        for(double v:{4.,0.,0.,1.,4.,4.,0.,std::sqrt(0.5),0.,4.,0.,1.})f64(b,v);
    } else for(double v:{0.,0.,0.,2.,0.,0.,5.,3.})f64(b,v);
    for(double knot:{0.,1.}) { f64(b,knot);u32(b,curved?3:2);u32(b,0); }
    return b;
}
double volume(uint64_t s,ifclite_smlib_handle h) { double v=0;ok(ifclite_smlib_volume(s,h,1e-8,&v));return v; }
ifclite_smlib_handle upload(uint64_t s,const std::vector<uint8_t>& b) {
    uint64_t token=0;ok(ifclite_smlib_sweep_begin(s,2,b.size(),1,1,&token));
    ok(ifclite_smlib_sweep_chunk(s,token,0,b.data(),b.size()));
    ifclite_smlib_handle h{};ok(ifclite_smlib_sweep_commit(s,token,&h));return h;
}
}
void run_disk_tests() {
    uint64_t s=0;ok(ifclite_smlib_session_create(&s));
    for(bool curved:{false,true}) {
        auto b=recipe(curved);const auto h=upload(s,b);
        const double expected=pi*0.25*0.25*(curved?2*pi:5);
        const double actual=volume(s,h);
        std::fprintf(stderr,"disk witness curved=%d volume=%.17g expected=%.17g delta=%.17g\n",
            int(curved),actual,expected,actual-expected);
        expect(std::abs(actual-expected)<expected*1e-4);
        // Independent tight bounds on the straight cylinder made from a nonuniform rational parameterization.
        if(!curved) {
            auto direct=create_authored_disk(b);SmPoint3d low,high;
            expect(SmApiBrepBoundingBox(direct.get(),TRUE,low,high)==SM_SUCCESS);
            expect(std::abs(low[0]+0.25)<1e-5 && std::abs(high[0]-0.25)<1e-5);
            expect(std::abs(low[2])<1e-5 && std::abs(high[2]-5)<1e-5);
        }
        ok(ifclite_smlib_release(s,h));
    }
    // Rotated+translated copy: mesh bounds move while original volume and bounds remain fixed.
    ifclite_smlib_handle box{},moved{},mesh{};ok(ifclite_smlib_box(s,0,0,0,2,3,4,&box));
    double matrix[16]={0,1,0,0,-1,0,0,0,0,0,1,0,10,20,30,1};
    ok(ifclite_smlib_transform(s,box,matrix,&moved));
    for(const auto h:{box,moved}) {
        expect(std::abs(volume(s,h)-24)<1e-5);
        ok(ifclite_smlib_tessellate(s,h,0.01,10,&mesh));
        ifclite_smlib_mesh_info info{};ok(ifclite_smlib_mesh_get_info(s,mesh,&info));
        double low[3]={1e9,1e9,1e9},high[3]={-1e9,-1e9,-1e9};
        for(uint32_t offset=0;offset<3*info.vertex_count;) {
            double values[480];const uint32_t n=std::min(480u,3*info.vertex_count-offset);
            ok(ifclite_smlib_mesh_copy(s,mesh,1,offset,n,values,sizeof(values)));
            for(uint32_t j=0;j<n;++j) {const unsigned axis=(offset+j)%3;
                low[axis]=std::min(low[axis],values[j]);high[axis]=std::max(high[axis],values[j]);}
            offset+=n;
        }
        const bool is_moved=h.slot==moved.slot;
        expect(std::abs(low[0]-(is_moved?7:0))<1e-5 && std::abs(high[0]-(is_moved?10:2))<1e-5);
        expect(std::abs(low[1]-(is_moved?20:0))<1e-5 && std::abs(high[1]-(is_moved?22:3))<1e-5);
        expect(std::abs(low[2]-(is_moved?30:0))<1e-5 && std::abs(high[2]-(is_moved?34:4))<1e-5);
        ok(ifclite_smlib_release(s,mesh));
    }
    ifclite_smlib_handle out{99,99,99};
    matrix[0]=2;expect(ifclite_smlib_transform(s,box,matrix,&out)==1 && out.session==0);
    expect(std::abs(volume(s,box)-24)<1e-5);
    matrix[0]=std::numeric_limits<double>::quiet_NaN();expect(ifclite_smlib_transform(s,box,matrix,&out)==1);
    // Malformed rational inputs reject before SDK construction; matching commit consumes upload.
    for(unsigned scenario=0;scenario<4;++scenario) {
        auto invalid=recipe(false);
        if(scenario==0) { // zero rational weight
            for(unsigned j=0;j<8;++j)invalid[96+j]=0;
        } else if(scenario==1) { // repeated unique knots
            for(unsigned j=0;j<8;++j)invalid[152+j]=0;
        } else if(scenario==2) { // hollow semantics unavailable
            double inner=0.1;std::memcpy(invalid.data()+24,&inner,8);
        } else { // trim outside knot domain
            double end=2;std::memcpy(invalid.data()+64,&end,8);
        }
        uint64_t upload=0;ok(ifclite_smlib_sweep_begin(s,2,invalid.size(),1,1,&upload));
        ok(ifclite_smlib_sweep_chunk(s,upload,0,invalid.data(),invalid.size()));
        expect(ifclite_smlib_sweep_commit(s,upload,&out)==(scenario==2?7:1));
        expect(out.session==0 && ifclite_smlib_sweep_commit(s,upload,&out)==3);
    }
    auto invalid=recipe(false);invalid.pop_back();
    // The shortest record is rejected by the declaration gate before upload.
    uint64_t token=99;expect(ifclite_smlib_sweep_begin(s,2,invalid.size(),1,1,&token)==1 && token==0);
    // A truncated longer record passes declaration size admission but must fail
    // exact payload validation, consume its upload, and publish no handle.
    invalid=recipe(true);invalid.pop_back();
    ok(ifclite_smlib_sweep_begin(s,2,invalid.size(),1,1,&token));
    ok(ifclite_smlib_sweep_chunk(s,token,0,invalid.data(),invalid.size()));
    expect(ifclite_smlib_sweep_commit(s,token,&out)==1 && out.session==0);
    expect(ifclite_smlib_sweep_commit(s,token,&out)==3);
    ok(ifclite_smlib_session_destroy(s));
}
