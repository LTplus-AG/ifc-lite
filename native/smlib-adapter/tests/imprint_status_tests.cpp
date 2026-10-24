// SPDX-License-Identifier: MPL-2.0
// #7955 actual SDK intersection/imprint/classification, with failed edge imprints.
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiBrep.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <SmFace.h>
#include <SmAttribute.h>
#include <SmMerge.h>
#include <SmProtoTopology.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
bool inject=false;
unsigned edge_calls=0,completed_edges=0,failed_retired=0,relationships=0,manager_cleanups=0;
void require(bool ok,const char* message) {
    if(!ok) { std::fprintf(stderr,"imprint FAIL: %s\n",message); std::fflush(nullptr); std::_Exit(1); }
}
double volume(SmBrep* body) {
    double v=0; require(SmApiBrepComputeVolume(body,1e-8,v)==SM_SUCCESS,"volume read"); return v;
}
unsigned classifications(SmBrep* body) {
    SmTArray<SmFace*> faces; body->GetFaces(faces); unsigned count=0;
    for(auto* f:faces) count+=(f->FindAttribute(SM_AI_BOOLEAN_SAVE)!=nullptr)+(f->FindAttribute(SM_AI_BOOLEAN_DELETE)!=nullptr);
    return count;
}
}
// Linked only with test-generated intersector TU. No hook in shipped kernel.
SmStatus ifclite_test_edge_imprint(SmEdgeDefinition* definition) {
    ++edge_calls;
    // Skip two actual planned imprints: genuine incomplete topology. Different
    // failures require propagation of the FIRST, not last or relationship status.
    if(inject && edge_calls==1) return SM_ERR;
    if(inject && edge_calls==2) return SM_ERR_NULL_POINTER;
    const auto status=definition->Imprint();
    if(status==SM_SUCCESS) ++completed_edges;
    return status;
}
void ifclite_test_failed_definition_retired() { ++failed_retired; }
void ifclite_test_relationships() {
    ++relationships;
    // Trip the semantic invariant at the first forbidden continuation. A reverse
    // mutant must not traverse the deliberately incomplete graph and crash/hang
    // before the observer can report the actual status-loss defect.
    require(!inject,"first imprint failure stops relationships and Boolean publication");
}
void ifclite_test_manager_cleaned(bool cleared) {
    require(cleared,"prototype manager slot cleared after actual destructor"); ++manager_cleanups;
}
int main(int argc,char** argv) {
    if(argc!=3) return 64;
    inject=std::strcmp(argv[1],"failure")==0;
    if(!inject && std::strcmp(argv[1],"healthy")!=0) return 64;
    const bool classify=std::strcmp(argv[2],"classify")==0;
    SmBooleanOperationType operation=SM_BO_INTERSECTION;
    if(std::strcmp(argv[2],"union")==0) operation=SM_BO_UNION;
    else if(std::strcmp(argv[2],"difference")==0) operation=SM_BO_DIFFERENCE;
    else if(!classify && std::strcmp(argv[2],"intersection")!=0) return 64;
    SmApiCreateContext(); auto& context=*SmApiGetOrCreateContext();
    SmBrep *a=nullptr,*b=nullptr,*result=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,a)==SM_SUCCESS && a,"first box");
    require(SmApiCreateBox(SmVector3d(.5,.5,.5),2,2,2,b)==SM_SUCCESS && b,"overlapping box");
    require(std::abs(volume(a)-8)<1e-6 && std::abs(volume(b)-8)<1e-6,"source box volumes");
    {
        SmMerge merge(context,a,b); merge.SetClassifyFaces(classify?TRUE:FALSE);
        const auto status=merge.ManifoldBoolean(operation,result);
        // Check the intended semantic marker first for the independent reverse
        // mutation; incidental cleanup/volume errors cannot count as its kill.
        if(inject) {
            require(status==SM_ERR && !result && relationships==0,
                "first imprint failure stops relationships and Boolean publication");
            require(edge_calls>=3 && completed_edges>0 && failed_retired==2,
                "two real failed definitions retired while other actual imprints completed");
            require(manager_cleanups==1,"failed imprint manager destroyed exactly once before return");
        } else {
            require(status==SM_SUCCESS && result==a && relationships==1 && manager_cleanups==1,
                "healthy Boolean completes relationships and releases prototype manager");
            require(edge_calls>0 && completed_edges==edge_calls && failed_retired==0,
                "healthy control executes all actual edge imprints");
            if(classify) {
                require(classifications(a)+classifications(b)>0,"healthy classification creates real face classifications");
                require(std::abs(volume(a)-8)<1e-6 && std::abs(volume(b)-8)<1e-6,
                    "classification preserves both solid volumes");
            } else {
                const double expected=operation==SM_BO_UNION?12.625:operation==SM_BO_INTERSECTION?3.375:4.625;
                require(std::abs(volume(result)-expected)<1e-6,"healthy result matches fixed overlapping-box volume");
                SmBoolean manifold=FALSE;
                require(SmApiBrepIsManifoldSolid(result,manifold)==SM_SUCCESS && manifold,"healthy result manifold");
            }
        }
    }
    require(manager_cleanups==1,"intersector teardown does not double-destroy prototype manager");
    if(!inject) { delete a; if(classify) delete b; }
    // Failed imprint leaves operands partially modified. Do not traverse them
    // or retry; process disposal is the adapter's existing uncertainty boundary.
    std::printf("imprint PASS: %s %s\n",argv[1],argv[2]); std::fflush(nullptr);
    if(inject) std::_Exit(0);
    return 0;
}
