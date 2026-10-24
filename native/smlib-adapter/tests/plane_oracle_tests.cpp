// SPDX-License-Identifier: MPL-2.0
// #7955 NATIVE-01/02: independent face enclosure and clipped patch invariants.
// Fixed before SDK execution; a failed oracle is a qualification blocker.
#include "plane_domain.hpp"
#include "patch_accuracy_diagnostic.hpp"
#include "patch_edge_oracle.hpp"
#include "plane.hpp"
#include "mesh.hpp"
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBSplineSurface.h>
#include <SmCone.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <vector>
namespace {
void require(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"plane oracle FAIL: %s\n",message); std::exit(1); }
}
void near(double actual,double expected) {
    require(std::isfinite(actual) && std::abs(actual-expected)<=std::max(1e-12,std::abs(expected)*2e-5),
        "source-integral volume");
}
void cylinder_face() {
    SmBrep* raw=nullptr;
    require(SmApiCreateCylinder(SmVector3d(-4,7,-5),2,3,raw)==SM_SUCCESS,"cylinder fixture");
    std::unique_ptr<SmBrep> source(raw);
    // Rotation has no axis-aligned column; all radial AND axial terms matter.
    SmAxis2Placement rotation(SmPoint3d(1,-2,4),SmVector3d(2./3,2./3,1./3),SmVector3d(-2./3,1./3,2./3));
    require(raw->Transform(rotation)==SM_SUCCESS,"rotate actual cylindrical BRep");
    SmTArray<SmFace*> faces; raw->GetFaces(faces); unsigned reached=0;
    for(auto* face:faces) {
        auto* surface=face->GetSurface();
        if(surface->GetType()!=SmCylinder_TYPE && surface->GetType()!=SmCone_TYPE) continue;
        ++reached; auto* cylinder=static_cast<SmCone*>(surface);
        SmBoolean first_swap=UNSURE;
        for(unsigned swapped=0;swapped<2;++swapped) {
            SmAxis2Placement frame; double radius=0,angle=0; SmBoolean swap=UNSURE,inside=UNSURE;
            require(cylinder->GetCanonical(frame,radius,angle,&swap,&inside)==SM_SUCCESS && angle==0,
                "raw cylinder coefficients");
            if(swapped) require(swap!=first_swap,"both actual UV flag states"); else first_swap=swap;
            const auto origin=frame.GetOrigin(),x=frame.GetXAxis(),y=frame.GetYAxis(),z=frame.GetZAxis();
            const auto step=cylinder->GetSTEPUVDomain();
            require(std::abs(step.GetUMax()-step.GetUMin()-360)<1e-12,"full angular period");
            PlaneDomain domain;
            const auto bounds=certify_plane_face_domain(face,0,domain);
            require(domain.methods==4 && domain.cylinder_count==1,"actual method4 face contribution");
            for(unsigned d=0;d<3;++d) {
                require(std::abs(x[d])>0.1 && std::abs(y[d])>0.1 && std::abs(z[d])>0.1,"oblique raw coefficients");
                // Independent extrema: A cos(theta)+B sin(theta) has amplitude
                // hypot(A,B), NOT the interval implementation's |A|+|B|.
                const double amplitude=radius*std::hypot(x[d],y[d]);
                const double low=origin[d]-amplitude+std::min(step.GetVMin()*z[d],step.GetVMax()*z[d]);
                const double high=origin[d]+amplitude+std::max(step.GetVMin()*z[d],step.GetVMax()*z[d]);
                require(bounds[d].lo<=low && bounds[d].hi>=high,"cylinder face-only extrema enclosure");
                double theta=std::atan2(y[d],x[d])*180/std::acos(-1.);
                for(double turn:{0.,180.}) {
                    double degrees=theta+turn;
                    while(degrees<step.GetUMin()) degrees+=360;
                    while(degrees>step.GetUMax()) degrees-=360;
                    require(degrees>step.GetUMin()+1e-6 && degrees<step.GetUMax()-1e-6,"interior angular witness");
                    for(double axial:{step.GetVMin(),step.GetVMid(),step.GetVMax()}) {
                        SmPoint2d uv; SmPoint3d actual;
                        require(cylinder->ConvertUVFromSTEPToNURBS(SmPoint2d(degrees,axial),uv)==SM_SUCCESS &&
                            cylinder->EvaluatePoint(uv,actual)==SM_SUCCESS,"actual UV-converted interior evaluation");
                        const double radians=degrees*std::acos(-1.)/180;
                        for(unsigned k=0;k<3;++k) {
                            const double expected=origin[k]+radius*(x[k]*std::cos(radians)+y[k]*std::sin(radians))+axial*z[k];
                            require(std::abs(actual[k]-expected)<=1e-10,"raw coefficient point oracle");
                            require(actual[k]>=bounds[k].lo && actual[k]<=bounds[k].hi,"face-only evaluated enclosure");
                        }
                    }
                }
            }
            if(!swapped) require(face->SwapUV()==SM_SUCCESS,"swap actual cylinder UV");
        }
    }
    require(reached==1,"one actual cylinder face tested");
}
void patch_boundary(SmBrep* output) {
    auto mesh=tessellate_mesh(output,0.001,5);
    require(mesh && mesh->info.triangle_count && !mesh->info.failed_faces && !mesh->info.boundary_edges &&
        !mesh->info.spine_edges,"generic patch closed tessellation");
    std::map<std::pair<unsigned,unsigned>,std::pair<unsigned,int>> edges;
    double volume=0; unsigned cap=0,bulge=0;
    for(unsigned i=0;i<mesh->info.vertex_count;++i) {
        const double x=mesh->positions[3*i],y=mesh->positions[3*i+1],z=mesh->positions[3*i+2];
        const double top=2+x*(2-x)*y*(2-y);
        const bool contained=std::isfinite(x) && std::isfinite(y) && std::isfinite(z) &&
            x>=0.5-1e-6 && x<=2+1e-6 && y>=-1e-6 && y<=2+1e-6 && z>=-1e-6 && z<=top+1e-6;
        if(!contained) {
            // #7955: retain the fixed oracle and expose the actual failing
            // geometry. A successful volume integral cannot diagnose a bad
            // boundary vertex; do not infer a tolerance fix from that alone.
            std::fprintf(stderr,"patch containment vertex=%u xyz=(%.17g,%.17g,%.17g) top=%.17g "
                "residuals=(%.17g,%.17g,%.17g,%.17g,%.17g,%.17g) limit=1e-6\n",
                i,x,y,z,top,0.5-x,x-2,-y,y-2,-z,z-top);
            SmTArray<SmFace*> faces; output->GetFaces(faces);
            std::vector<bool> reported(faces.GetSize(),false);
            for(unsigned t=0;t<mesh->info.triangle_count;++t) {
                if(mesh->indices[3*t]!=i && mesh->indices[3*t+1]!=i && mesh->indices[3*t+2]!=i) continue;
                const auto f=mesh->faces[t];
                require(f<faces.GetSize(),"diagnostic source face index");
                if(reported[f]) continue;
                reported[f]=true;
                std::fprintf(stderr,"patch containment incident_face=%u surface_type=%ld\n",
                    f,static_cast<long>(faces[f]->GetSurface()->GetType()));
            }
        }
        if(!contained) {
            try { diagnose_patch_accuracy(output,x,y,z); }
            catch(...) { std::fprintf(stderr,"patch diagnostic failed; original oracle remains failed\n"); }
        }
        require(contained,"source graph and clipping halfspace containment");
        const bool on_cap=std::abs(x-0.5)<=1e-6;
        require(on_cap || std::abs(x-2)<=1e-6 || std::abs(y)<=1e-6 || std::abs(y-2)<=1e-6 ||
            std::abs(z)<=1e-6 || std::abs(z-top)<=1e-6,"boundary lies on source faces or requested cap");
        cap+=on_cap; bulge+=z>2.1;
    }
    for(unsigned i=0;i<mesh->info.triangle_count;++i) {
        double q[3][3];
        for(unsigned j=0;j<3;++j) {
            const auto a=mesh->indices[3*i+j],b=mesh->indices[3*i+(j+1)%3];
            require(a<mesh->info.vertex_count && b<mesh->info.vertex_count,"bounded mesh indices");
            auto& edge=edges[std::minmax(a,b)]; ++edge.first; edge.second+=a<b?1:-1;
            for(unsigned d=0;d<3;++d) q[j][d]=mesh->positions[3*a+d];
        }
        volume+=(q[0][0]*(q[1][1]*q[2][2]-q[1][2]*q[2][1])+
            q[0][1]*(q[1][2]*q[2][0]-q[1][0]*q[2][2])+q[0][2]*(q[1][0]*q[2][1]-q[1][1]*q[2][0]))/6;
    }
    for(const auto& edge:edges) require(edge.second.first==2 && edge.second.second==0,"closed oriented patch mesh");
    require(cap>=3 && bulge>0,"actual cut cap and retained curved interior");
    require(std::abs(volume-7.5)<=7.5*2e-3,"independent signed patch mesh volume");
}
void patch_clip(SmBrep* source,bool edge_accuracy) {
    // Unit-weight biquadratic Bezier top: z=2+x(2-x)y(2-y).
    // Integral over [0,2]^2 is 8+16/9=88/9. Over [.5,2]x[0,2]
    // it is 6+(9/8)*(4/3)=15/2. No SDK value defines either oracle.
    const double plane[]={0.5,0,0,1,0,0}; ifclite_smlib_plane_certificate c{};
    std::unique_ptr<SmBrep> output;
    try { output=clip_finite_plane(source,plane,1,IFCLITE_SMLIB_INTERSECTION,c); }
    catch(const AdapterFailure&) { require(false,"generic method2 clip must succeed"); }
    require(output && c.version==1 && (c.method&2) && !c.empty && c.side==1 && c.mode==2 &&
        std::memcmp(c.plane,plane,sizeof(plane))==0,"actual successful method2 certificate");
    if(edge_accuracy) require_patch_edge_accuracy(output.get());
    double volume=0;
    require(SmApiBrepComputeVolume(output.get(),1e-8,volume)==SM_SUCCESS,"actual clipped patch volume"); near(volume,7.5);
    patch_boundary(output.get());
    require(SmApiBrepComputeVolume(source,1e-8,volume)==SM_SUCCESS,"preserved source patch volume"); near(volume,88./9.);
}
void control_net_interior(bool edge_accuracy=false) {
    // Domain invariant: a curved face interior can exceed every vertex/edge
    // bound. Elevate a real box's top patch, keep its boundary fixed, bulge only
    // its central control point. This is a full SDK BRep, not a mesh fixture.
    SmBrep* raw=nullptr; require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS,"SDK rational interior fixture");
    std::unique_ptr<SmBrep> source(raw);
    SmTArray<SmFace*> faces; raw->GetFaces(faces); SmFace* edited=nullptr;
    for(auto* f:faces) {
        auto* b=static_cast<SmBSplineSurface*>(f->GetSurface());
        SmPoint3d midpoint; const auto uv=f->GetUVDomain();
        require(b->EvaluatePoint(SmPoint2d(uv.GetUMid(),uv.GetVMid()),midpoint)==SM_SUCCESS,"actual top patch midpoint");
        if(midpoint.z!=2) continue;
        SmTArray<SmEdgeuse*> uses; f->GetUpwardEdgeuses(uses);
        std::vector<std::pair<SmEdgeuse*,std::unique_ptr<SmBSplineCurve>>> trims;
        for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            require(trim && owner,"existing exact top patch trim");
            trims.emplace_back(owner,std::unique_ptr<SmBSplineCurve>(new (*raw->GetContext()) SmBSplineCurve(*trim)));
        }
        auto* replacement=new (*raw->GetContext()) SmBSplineSurface(*b);
        require(replacement->DegreeElevate(SM_SP_U,2)==SM_SUCCESS && replacement->DegreeElevate(SM_SP_V,2)==SM_SUCCESS,"exact degree elevation");
        ULONG nu=0,nv=0; double* controls=nullptr;
        require(replacement->GetControlPointsPointer(nu,nv,controls)==SM_SUCCESS && nu==3 && nv==3,
            "single biquadratic Bezier control net");
        SmPoint3d corner,uend,vend; double corner_weight=0;
        require(replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,0,0,corner,corner_weight)==SM_SUCCESS &&
            replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,2,0,uend,corner_weight)==SM_SUCCESS &&
            replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,0,2,vend,corner_weight)==SM_SUCCESS,
            "source parameter axes");
        bool seen[3][3]{};
        for(unsigned i=0;i<3;++i) for(unsigned j=0;j<3;++j) {
            SmPoint3d cp; double w=0;
            require(replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,i,j,cp,w)==SM_SUCCESS &&
                (w==1 || w==NL_NOW) && cp.z==2,"unit-weight planar source control");
            const int x=static_cast<int>(cp.x),y=static_cast<int>(cp.y);
            require(x>=0 && x<=2 && y>=0 && y<=2 && cp.x==x && cp.y==y && !seen[x][y],
                "source control lattice for polynomial integral");
            require(cp.x==corner.x+(uend.x-corner.x)*i/2+(vend.x-corner.x)*j/2 &&
                cp.y==corner.y+(uend.y-corner.y)*i/2+(vend.y-corner.y)*j/2,
                "affine xy parameter map for source integral");
            seen[x][y]=true;
        }
        SmPoint3d point; double weight=0;
        require(replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,1,1,point,weight)==SM_SUCCESS,"real interior control");
        require(point.x==1 && point.y==1,"central control over source square centre");
        point.z=6;
        require(replacement->SetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,1,1,point,1)==SM_SUCCESS,"author rational bulge");
        f->SetSurface(replacement,TRUE);
        // SetSurface invalidates UV caches. Restore the actual original exact
        // boundary curves, whose geometry is unchanged by an interior bulge.
        for(auto& trim:trims) trim.first->SetUVTrimCurve(trim.second.release(),0,TRUE);
        edited=f; break;
    }
    require(edited,"top patch reached");
    const auto c=certify_plane_domain(raw);
    require(c.bounds[2].hi>=6 && c.faces==6,"complete surface control net encloses interior beyond vertex maximum2");
    patch_clip(raw,edge_accuracy);
    const auto previous=edited->GetUVDomain(); edited->SetUVDomain(SmExtent2d(-1,-1,3,3));
    bool cropped=false;
    try { certify_plane_domain(raw); } catch(const AdapterFailure& e) { cropped=e.status==7; }
    require(cropped,"cropped or unknown generic face domain cannot borrow full-patch certification");
    edited->SetUVDomain(previous); edited->RemoveUVTrimCurves();
    bool missing=false;
    try { certify_plane_domain(raw); } catch(const AdapterFailure& e) { missing=e.status==7; }
    require(missing,"missing generic UV containment cannot be replaced by disabled-extrapolation flag");
}
}
#ifdef IFCLITE_PATCH_ACCURACY_WORKER
extern "C" int ifclite_patch_accuracy_test() {
    control_net_interior(true);
    std::puts("plane oracle PASS");
    return 0;
}
#else
int main(int argc,char** argv) {
    require(argc==2,"select cylinder or patch oracle");
    if(std::strcmp(argv[1],"cylinder")==0) cylinder_face();
    else if(std::strcmp(argv[1],"patch")==0) control_net_interior();
    else if(std::strcmp(argv[1],"patch-edge")==0) control_net_interior(true);
    else require(false,"unknown oracle");
    std::puts("plane oracle PASS");
}

#endif
