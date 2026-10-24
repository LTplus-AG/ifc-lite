// SPDX-License-Identifier: MPL-2.0
// #7955: demonstrate the exact-seal discontinuity using the real SDK.
// This is a conversion diagnostic, never a face-ancestry authorization.
#include "copy.hpp"
#include "failure.hpp"
#include <SmApiPrimitives.h>
#include <SmCopyBrepMap.h>
#include <SmBSplineSurface.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmVertex.h>
#include <array>
#include <algorithm>
#include <stdexcept>
#include <vector>
namespace {
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
struct Side {
    SmFace* face; SmSurface* surface;
    std::array<double,3> lo{1e100,1e100,1e100},hi{-1e100,-1e100,-1e100};
    std::vector<std::pair<SmEdgeuse*,SmBSplineCurve*>> trims;
};
Side capture(SmFace* face) {
    Side result{face,face->GetSurface()};
    SmTArray<SmVertex*> corners; face->GetVertices(corners);
    require(corners.GetSize()==4,"conversion diagnostic has four actual source corners");
    for(auto* vertex:corners) {
        const auto p=vertex->GetPoint();
        for(unsigned axis=0;axis<3;++axis) {
            result.lo[axis]=std::min(result.lo[axis],p[axis]);
            result.hi[axis]=std::max(result.hi[axis],p[axis]);
        }
    }
    SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
    require(uses.GetSize()==4,"conversion diagnostic has four actual trim slots");
    for(auto* use:uses) result.trims.push_back({use,use->GetUVTrimCurve()});
    return result;
}
}
void run_affine_representation_diagnostic() {
    SmBrep* raw=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,3,4,raw)==SM_SUCCESS && raw,
        "actual asymmetric source box construction");
    std::unique_ptr<SmBrep> source(raw);
    SmTArray<SmFace*> original; source->GetFaces(original);
    std::vector<Side> before;
    for(auto* face:original) {
        auto side=capture(face);
        for(const auto& trim:side.trims) require(trim.second,"constructor supplies an actual UV trim");
        before.push_back(std::move(side));
    }
    SmCopyBrepMap map;
    auto working=checked_brep_copy(source.get(),nullptr,&map);
    SmTArray<SmFace*> faces; working->GetFaces(faces);
    std::vector<std::pair<SmFace*,SmFace*>> correspondence;
    // Consume the SDK map while valid, BEFORE the numerical edit. Never use a
    // stale post-edit map as ancestry evidence. Retained pairs are test evidence.
    for(auto* face:faces) {
        auto* parent=map.GetAt(face);
        const auto found=std::find_if(before.begin(),before.end(),[&](const Side& side) { return side.face==parent; });
        require(found!=before.end(),"actual SDK copy map names a source face");
        correspondence.push_back({face,found->face});
    }
    try {
        require(working->TurnToNURBS()==SM_SUCCESS,"actual rational conversion status");
        SmTArray<SmFace*> after; working->GetFaces(after);
        require(after.GetSize()==6 && correspondence.size()==6,"conversion preserves six physical faces");
        unsigned missing=0;
        for(auto pair:correspondence) {
            unsigned count=0; for(auto* face:after) count+=face==pair.first;
            require(count==1,"conversion retains each mapped physical face exactly once");
            const auto found=std::find_if(before.begin(),before.end(),[&](const Side& side) { return side.face==pair.second; });
            const auto converted=capture(pair.first);
            require(converted.lo==found->lo && converted.hi==found->hi,
                "converted physical face agrees with source-derived analytic side");
            require(converted.surface->GetType()==SmBSplineSurface_TYPE,
                "conversion replaces analytic evaluator with generic rational surface");
            for(const auto& trim:converted.trims) missing+=trim.second==nullptr;
        }
        require(missing==24,"rational conversion leaves every box upward UV trim absent");
        for(const auto& side:before) {
            const auto unchanged=capture(side.face);
            require(unchanged.surface==side.surface && unchanged.lo==side.lo && unchanged.hi==side.hi &&
                unchanged.trims==side.trims,"conversion preserves original physical faces and raw trim ownership");
        }
    } catch(...) {
        working.release(); source.release();
        throw; // diagnostic process exits; no speculative SDK cleanup after failure
    }
}
