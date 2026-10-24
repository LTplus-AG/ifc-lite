// SPDX-License-Identifier: MPL-2.0
// #7955: original physical source faces are the oracle, never array position.
#include "owned_lineage_geometry.hpp"
#include "representation_seal.hpp"
#include <map>
#include <cstdio>
namespace {
using namespace face_lineage;
using M=std::array<double,16>; using V=std::array<double,3>;
using owned_geometry::require;
V cross(V a,V b) { return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
double dot(V a,V b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
V sub(V a,V b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
V inverse(const M& m,V p) {
    V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};
    auto q=sub(p,{m[12],m[13],m[14]}); const auto d=dot(a,cross(b,c));
    return {dot(q,cross(b,c))/d,dot(q,cross(c,a))/d,dot(q,cross(a,b))/d};
}
V normal(const M& m,V n) {
    V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};
    auto x=cross(b,c),y=cross(c,a),z=cross(a,b); const auto d=dot(a,x); V out{};
    for(unsigned k=0;k<3;++k) out[k]=(x[k]*n[0]+y[k]*n[1]+z[k]*n[2])/d;
    const auto length=std::sqrt(dot(out,out)); for(auto& v:out) v/=length; return out;
}
void mesh_oracle(const OwnedBoundary& result,const M& m,const std::vector<owned_geometry::FaceBox>& source) {
    const auto identities=result.faces();
    for(double chord:{.01,.005}) {
        auto mesh=result.tessellate(chord,15);
        require(mesh->provenance.triangles.size()==mesh->indices.size()/3,"affine triangles retain complete attribution");
        double volume=0; std::vector<Identity> seen;
        std::map<std::pair<uint32_t,uint32_t>,std::pair<unsigned,int>> incidence;
        for(size_t t=0;t<mesh->provenance.triangles.size();++t) {
            const auto roots=result.ancestors(mesh->provenance.triangles[t]);
            require(roots.size()==1,"affine preserves the complete original per-face ancestor set");
            auto face=std::find_if(source.begin(),source.end(),[&](const auto& f){return f.root==roots[0].identity;});
            require(face!=source.end(),"affine ancestry is an original constructor face, never a new root");
            if(std::find(seen.begin(),seen.end(),roots[0].identity)==seen.end()) seen.push_back(roots[0].identity);
            V outward{};
            for(unsigned k=0;k<3;++k) if(face->lo[k]==face->hi[k]) outward[k]=face->lo[k]==0?-1:1;
            const auto n=normal(m,outward); V p[3];
            for(unsigned c=0;c<3;++c) {
                auto id=mesh->indices.at(3*t+c);
                for(unsigned k=0;k<3;++k) p[c][k]=mesh->positions.at(3*id+k);
                const auto local=inverse(m,p[c]);
                for(unsigned k=0;k<3;++k) {
                    require(local[k]>=face->lo[k]-1e-8 && local[k]<=face->hi[k]+1e-8,
                        "affine triangle geometry matches its original physical ancestor");
                }
                auto next=mesh->indices.at(3*t+(c+1)%3); auto& edge=incidence[std::minmax(id,next)];
                ++edge.first; edge.second+=id<next?1:-1;
            }
            for(unsigned c=0;c<3;++c) for(unsigned k=0;k<3;++k)
                require(std::abs(mesh->normals.at(9*t+3*c+k)-n[k])<1e-7,
                    "affine corner normal matches source inverse transpose");
            require(dot(cross(sub(p[1],p[0]),sub(p[2],p[0])),n)>0,"reflected affine winding is outward");
            const V origin{m[12],m[13],m[14]};
            volume+=dot(sub(p[0],origin),cross(sub(p[1],origin),sub(p[2],origin)))/6;
        }
        const double determinant=dot({m[0],m[1],m[2]},cross({m[4],m[5],m[6]},{m[8],m[9],m[10]}));
        require(std::abs(volume-24*std::abs(determinant))<1e-6,"affine signed volume matches source determinant");
        for(auto edge:incidence) require(edge.second.first==2 && edge.second.second==0,"affine boundary is closed with opposed incidence");
        require(seen.size()==6 && result.faces()==identities,"affine ancestry and identity survive retessellation");
    }
}
}
void run_affine_lineage_positive() {
    const M identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    for(const auto& m:{identity,M{0,1,0,0,-1,0,0,0,0,0,1,0,7,-4,2,1},
        M{2,0,0,0,0,3,0,0,0,0,4,0,7,-4,2,1},
        M{2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1},
        M{-2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1}}) {
        auto source=OwnedBoundary::box(2,3,4); auto sibling=source.copy();
        auto& ledger=const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(source));
        RepresentationSeal source_seal(ledger,const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(source)));
        RepresentationSeal sibling_seal(ledger,const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(sibling)));
        const auto original=owned_geometry::source_faces(source);
        auto transformed=source.affine(m.data());
        mesh_oracle(transformed,m,original);
        auto copied=transformed.copy(); mesh_oracle(copied,m,original);
        auto repeated=transformed.affine(identity.data()); mesh_oracle(repeated,m,original);
        source_seal.verify(); sibling_seal.verify();
    }
}
