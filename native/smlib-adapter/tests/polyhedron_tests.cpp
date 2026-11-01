// SPDX-License-Identifier: MPL-2.0
// Authored-triangle solids: closed shells, refusals, tessellation, a real cut.
#include "ifclite_smlib.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
namespace {
void expect_at(bool v,const char* expression,int line) {
    if(!v) {
        char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"polyhedron witness failed line=%d expression=%s error=%s\n",line,expression,error);
        std::abort();
    }
}
#define expect(value) expect_at((value),#value,__LINE__)
#define ok(status) expect((status)==0)
void u32(std::vector<uint8_t>& b,uint32_t v) { for(unsigned j=0;j<4;++j) b.push_back(uint8_t(v>>(8*j))); }
void f64(std::vector<uint8_t>& b,double v) { uint64_t bits; std::memcpy(&bits,&v,8);
    for(unsigned j=0;j<8;++j) b.push_back(uint8_t(bits>>(8*j))); }
std::vector<uint8_t> recipe(const std::vector<double>& points,const std::vector<uint32_t>& corners) {
    std::vector<uint8_t> b;
    const uint32_t triangles=uint32_t(corners.size()/3);
    for(uint32_t v:{3u,uint32_t(points.size()/3),triangles,triangles}) u32(b,v);
    for(double v:points) f64(b,v);
    for(uint32_t v:corners) u32(b,v);
    for(uint32_t t=0;t<triangles;++t) u32(b,t);
    return b;
}
int32_t upload(uint64_t s,const std::vector<uint8_t>& bytes,uint32_t triangles,ifclite_smlib_handle* out) {
    uint64_t token=0;
    ok(ifclite_smlib_sweep_begin(s,3,uint32_t(bytes.size()),1,triangles,&token));
    ok(ifclite_smlib_sweep_chunk(s,token,0,bytes.data(),uint32_t(bytes.size())));
    return ifclite_smlib_sweep_commit(s,token,out);
}
const std::vector<double> CUBE={0,0,0,2,0,0,2,2,0,0,2,0,0,0,2,2,0,2,2,2,2,0,2,2};
const std::vector<uint32_t> CUBE_FACES={0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7};
}
int main() {
    expect(ifclite_smlib_capabilities()&IFCLITE_SMLIB_CAPABILITY_SWEEP_POLYHEDRON);
    uint64_t s=0; ok(ifclite_smlib_session_create(&s));
    ifclite_smlib_handle cube{};
    ok(upload(s,recipe(CUBE,CUBE_FACES),12,&cube));
    double volume=0; ok(ifclite_smlib_volume(s,cube,1e-8,&volume));
    expect(std::abs(volume-8)<1e-6);
    uint32_t manifold=0; ok(ifclite_smlib_manifold(s,cube,&manifold)); expect(manifold==1);
    // A real cut through two faces of the authored shell.
    ifclite_smlib_handle cutter{},result{};
    ok(ifclite_smlib_box(s,0.5,0.5,-1,1,1,4,&cutter));
    ok(ifclite_smlib_boolean(s,cube,cutter,IFCLITE_SMLIB_DIFFERENCE,&result));
    ok(ifclite_smlib_volume(s,result,1e-8,&volume));
    expect(std::abs(volume-6)<1e-6);
    // An open shell: the last two triangles are absent, so no solid exists.
    std::vector<uint32_t> open(CUBE_FACES.begin(),CUBE_FACES.end()-6);
    ifclite_smlib_handle refused{};
    expect(upload(s,recipe(CUBE,open),10,&refused)==IFCLITE_SMLIB_UNSUPPORTED);
    ok(ifclite_smlib_session_destroy(s));
    std::puts("SMLib polyhedron: closed shells, cuts and open-shell refusal passed");
    return 0;
}
