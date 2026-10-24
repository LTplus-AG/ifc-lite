// SPDX-License-Identifier: MPL-2.0
// #7955: production dispatch, independent authored constructions, real affine
// correspondence and final triangles. No OwnedBoundary/test-only adoption.
#include "protocol.h"
#include "ifclite_smlib.h"
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>
namespace {
using Bytes=std::vector<uint8_t>;
uint32_t serial=0;
void expect(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
void u32(Bytes& b,uint32_t v) { for(unsigned i=0;i<4;++i)b.push_back(uint8_t(v>>(8*i))); }
void u64(Bytes& b,uint64_t v) { u32(b,uint32_t(v));u32(b,uint32_t(v>>32)); }
void f64(Bytes& b,double v) { uint64_t n;std::memcpy(&n,&v,8);u64(b,n); }
uint32_t word(const Bytes& b,size_t i) { expect(i+4<=b.size(),"bounded source reply");uint32_t n=0;for(unsigned j=0;j<4;++j)n|=uint32_t(b[i+j])<<(8*j);return n; }
Bytes call(uint32_t op,const Bytes& body={}) {
    Bytes b;u32(b,1);u32(b,++serial);u32(b,op);b.insert(b.end(),body.begin(),body.end());
    auto r=ifclite_smlib_dispatch(b);
    expect(word(r,8)==0,"source binding production dispatch succeeds");return Bytes(r.begin()+12,r.end());
}
Bytes body(uint64_t session,const Bytes& handle={}) { Bytes b;u64(b,session);b.insert(b.end(),handle.begin(),handle.end());return b; }
Bytes construct(uint64_t session,uint32_t entity) {
    Bytes recipe;for(uint32_t v:{1u,1u,4u,0u})u32(recipe,v);
    for(double v:{0.,0.,1.,3.})f64(recipe,v);u32(recipe,0);u32(recipe,4);
    const double points[4][2]={{0,0},{2,0},{2,4},{0,4}};
    for(unsigned i=0;i<4;++i) {
        u32(recipe,1);u32(recipe,0);
        for(double v:{points[i][0],points[i][1],0.,points[(i+1)%4][0],points[(i+1)%4][1],0.,0.,0.,0.,0.,0.,0.})f64(recipe,v);
    }
    auto begin=body(session);for(uint32_t v:{1u,uint32_t(recipe.size()),1u,4u})u32(begin,v);
    auto upload=call(13,begin);auto chunk=body(session,upload);u32(chunk,0);u32(chunk,uint32_t(recipe.size()));
    chunk.insert(chunk.end(),recipe.begin(),recipe.end());call(14,chunk);
    auto commit=body(session,upload);u32(commit,1);u64(commit,91);u64(commit,7);u64(commit,11);u32(commit,entity);
    return call(21,commit);
}
}
int main(int argc,char**) {
    try {
        auto sessionBytes=call(1);uint64_t session=word(sessionBytes,0)|(uint64_t(word(sessionBytes,4))<<32);
        auto first=construct(session,101),second=construct(session,102);
        auto a=call(22,body(session,first)),b=call(22,body(session,second));
        expect(word(a,0)==1 && word(a,76)==6,"complete initial construction role inventory");
        expect(a!=b,"independent source objects never share issuance");
        // Six roles: four authored segment sweeps, start cap, end cap.
        for(unsigned i=0;i<6;++i) {
            expect(word(a,80+24*i+16)==(i<4?1u:i-2),"direct construction role corresponds to authored feature");
            expect(word(a,80+24*i+20)==(i<4?i:0u),"direct construction segment ordinal is preserved");
        }
        if(argc>1) return 0; // Constructor lane independent of known tessellation hold.
        auto affine=body(session,first);
        for(double v:{-2.,0.,0.,0.,0.,3.,0.,0.,0.,0.,0.5,0.,7.,-1.,2.,1.})f64(affine,v);
        auto transformed=call(18,affine);transformed.resize(16);
        auto c=call(22,body(session,transformed));
        expect(Bytes(a.begin()+20,a.end())==Bytes(c.begin()+20,c.end()),"affine preserves complete source construction inventory");
        auto tess=body(session,transformed);f64(tess,0.001);f64(tess,5);
        auto mesh=call(9,tess),info=call(10,body(session,mesh));
        const auto triangles=word(info,4);expect(triangles>0,"source triangles exist");
        unsigned occupied=0;
        for(uint32_t offset=0;offset<triangles;) {
            const uint32_t n=std::min(480u,triangles-offset);auto read=body(session,mesh);
            u32(read,5);u32(read,offset);u32(read,n);auto rows=call(11,read);
            for(uint32_t i=0;i<n;++i) { auto role=word(rows,4*i);expect(role<6,"triangle construction root bound");occupied|=1u<<role; }
            offset+=n;
        }
        expect(occupied==63,"actual tessellation consumes complete construction correspondence");
        call(2,body(session));return 0;
    } catch(const std::exception& e) { std::fprintf(stderr,"SOURCE_BINDING_ASSERT: %s\n",e.what());return 42; }
}
