// SPDX-License-Identifier: MPL-2.0
#include "affine_rational.hpp"
#include "source_construction.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <vector>
#include <cstring>
namespace {
void require(bool ok,const char* why) { if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
void checked(SmStatus status) { require(status==SM_SUCCESS,"owned rational coefficient getter failed"); }
// Compare exact parameterization, not just positions at a few samples. Analytic
// subclasses already have materialized rational data (affine preflight checked).
std::vector<double> curve_data(SmBSplineCurve& c) {
    ULONG n=0; double* p=nullptr;
    checked(c.GetControlPointsPointer(n,p));
    require(n && n<=16384 && p && c.GetGwNurbPointer() && !c.IsNurbBorrowed(),"bounded owned rational curve");
    std::vector<double> data{double(c.GetDim()),double(c.GetDegree()),double(n),double(c.IsOutOfBoundsEnabled()),double(c.GetInsideOut())};
    const auto interval=c.GetNaturalInterval(); data.push_back(interval.GetMin()); data.push_back(interval.GetMax());
    data.insert(data.end(),p,p+4*n);
    SmTArray<double> knots; checked(c.GetKnotsAll(knots));
    require(knots.GetSize()<=65536,"owned curve knot budget");
    data.push_back(double(knots.GetSize()));
    data.insert(data.end(),knots.GetDataArray(),knots.GetDataArray()+knots.GetSize()); return data;
}
std::vector<double> surface_data(SmBSplineSurface& s) {
    ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
    checked(s.GetControlPointsPointer(nu,nv,p)); checked(s.GetKnotsPointers(ku,kv,u,v));
    require(nu && nv && nu<=16384/nv && ku<=65536 && kv<=65536 && p && u && v &&
        s.GetGwNurbPointer() && !s.IsNurbBorrowed(),"bounded owned rational surface");
    const auto uv=s.GetNaturalUVDomain();
    std::vector<double> data{double(nu),double(nv),double(ku),double(kv),double(s.GetDegree(SM_SP_U)),double(s.GetDegree(SM_SP_V)),
        uv.GetUMin(),uv.GetUMax(),uv.GetVMin(),uv.GetVMax(),double(s.IsOutOfBoundsEnabled()),
        double(s.IsUsingNewPointSolvers()),double(s.GetBSplineSurfaceForm())};
    data.insert(data.end(),p,p+4*nu*nv); data.insert(data.end(),u,u+ku); data.insert(data.end(),v,v+kv); return data;
}
void equal(const std::vector<double>& a,const std::vector<double>& b) {
    require(a.size()==b.size() && std::memcmp(a.data(),b.data(),a.size()*sizeof(double))==0,
        "owned rationalization changed original coefficients or parameter bounds");
}
struct Trim { SmEdgeuse* use; SmBSplineCurve* curve; std::vector<double> data; };
}
namespace {
void normalize_initial_data(SmBrep& body) {
    auto* context=const_cast<SmContext*>(body.GetContext());
    SmTArray<SmFace*> faces; body.GetFaces(faces);
    SmTArray<SmEdge*> edges; body.GetEdges(edges);
    require(faces.GetSize()<=1024 && edges.GetSize()<=2048,"owned normalization topology bound");
    std::vector<Trim> trims; size_t words=0;
    for(auto* face:faces) {
        SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
        require(uses.GetSize()<=8192-trims.size(),"owned normalization trim budget");
        for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* curve=use->GetUVTrimCurve(&owner);
            require(curve && owner && owner->GetMate() && owner->GetMate()->GetMate()==owner &&
                owner->GetBrep()==&body && owner->GetFace()==face && curve->GetOwner()==owner &&
                owner->GetUVTrimCurvePointer()==curve && !owner->GetMate()->GetUVTrimCurvePointer() &&
                !owner->GetDropCurveFail(),"owned normalization requires exact canonical source trim slots");
            bool seen=false; for(const auto& trim:trims) seen|=trim.use==owner;
            if(seen) continue;
            auto data=curve_data(*curve); words+=data.size();
            require(words<=1048576,"owned normalization retained coefficient budget");
            trims.push_back({owner,curve,std::move(data)});
        }
    }
    // SDK SetUVTrimCurve(nullptr,0,FALSE) detaches without deleting or fitting;
    // the original curve still names its original canonical owner. No copy,
    // knot normalization, numerical projection or approximation occurs here.
    for(auto& trim:trims) {
        trim.use->SetUVTrimCurve(nullptr,0.,FALSE);
        if(trim.curve->GetType()!=SmBSplineCurve_TYPE && trim.curve->GetType()!=SmLine_TYPE) {
            auto* generic=new (*context) SmBSplineCurve(*trim.curve);
            equal(trim.data,curve_data(*generic)); delete trim.curve; trim.curve=generic;
        }
    }
    for(auto* face:faces) {
        auto* old=face->GetSurface(); require(old && old->IsKindOf(SmBSplineSurface_TYPE),"rational surface eligibility");
        if(old->GetType()==SmBSplineSurface_TYPE) continue;
        const auto data=surface_data(*static_cast<SmBSplineSurface*>(old));
        const auto domain=face->GetUVDomain(); const auto rectangular=face->GetRectangularTrim();
        auto* generic=new (*context) SmBSplineSurface(*static_cast<SmBSplineSurface*>(old));
        equal(data,surface_data(*generic));
        // Unlike ReplaceSurface, SetSurface does not refit/create UV curves.
        face->SetSurface(generic,TRUE);
        face->SetUVDomain(domain); face->SetIsRectangularTrim(rectangular);
        require(generic->GetOwner()==face && face->GetSurface()==generic,"owned normalized surface backlink");
    }
    for(auto* edge:edges) {
        auto* old=edge->GetCurve(); require(old && old->IsKindOf(SmBSplineCurve_TYPE),"rational curve eligibility");
        if(old->GetType()==SmBSplineCurve_TYPE) continue;
        const auto data=curve_data(*static_cast<SmBSplineCurve*>(old));
        auto* generic=new (*context) SmBSplineCurve(*static_cast<SmBSplineCurve*>(old));
        equal(data,curve_data(*generic));
        edge->SetCurve(generic,TRUE); generic->SetOwner(edge);
        require(generic->GetOwner()==edge && edge->GetCurve()==generic,"owned normalized curve backlink");
    }
    for(auto& trim:trims) {
        require(!trim.use->GetUVTrimCurve() && !trim.use->GetDropCurveFail(),"normalization must not synthesize UV trims");
        equal(trim.data,curve_data(*trim.curve));
        trim.use->SetUVTrimCurve(trim.curve,0.,FALSE);
        require(trim.use->GetUVTrimCurvePointer()==trim.curve && trim.curve->GetOwner()==trim.use &&
            !trim.use->GetMate()->GetUVTrimCurvePointer(),"exact original UV slot restored");
    }
    SmTArray<SmFace*> after; body.GetFaces(after);
    require(after.GetSize()==faces.GetSize(),"normalization changed physical face inventory");
    for(auto* face:faces) {
        unsigned hits=0; for(auto* actual:after) hits+=actual==face;
        require(hits==1,"normalization lost original physical source-face correspondence");
    }
}

}
void normalize_owned_rational(SmBrep& body) {
    auto* context=const_cast<SmContext*>(body.GetContext());
    require(context && !context->GetUserNotifyCallback() && !context->GetSysNotifyCallback() &&
        !context->GetAttributeCallbacks(),"rational normalization is fixed pre-issuance construction only");
    normalize_initial_data(body);
}
void normalize_constructed_rational(SmBrep& body,const face_lineage::SourceConstruction& receipt) {
    receipt.validate_initial(body);
    normalize_initial_data(body);
    receipt.validate_initial(body);
}

std::unique_ptr<SmBSplineSurface> copy_initial_surface(SmBrep& body,SmBSplineSurface& surface,const face_lineage::SourceConstruction& receipt) {
    receipt.validate_initial(body);
    require(surface.GetContext()==body.GetContext() && !surface.GetOwner(),"initial surface must be unattached in constructor context");
    const auto data=surface_data(surface);
    auto result=std::unique_ptr<SmBSplineSurface>(new (*body.GetContext()) SmBSplineSurface(surface));
    equal(data,surface_data(*result));receipt.validate_initial(body);return result;
}
