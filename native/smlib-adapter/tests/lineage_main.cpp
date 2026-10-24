// SPDX-License-Identifier: MPL-2.0
#include "copy.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <cstdio>
#include <exception>
void run_face_lineage_tests();
void run_face_lineage_case(const char*);
int main(int argc,char** argv) {
    try {
        SmApiCreateContext();
        if(argc==1) run_face_lineage_tests();
        else if(argc==2) run_face_lineage_case(argv[1]);
        else return 2;
        return 0;
    } catch(const AdapterFailure& e) { std::fprintf(stderr,"lineage FAIL: %s (status %d)\n",e.message,e.status); }
    catch(const KernelDomainTainted& e) { std::fprintf(stderr,"lineage TAINT: %s\n",e.message.c_str()); }
    catch(const std::exception& e) { std::fprintf(stderr,"lineage FAIL: %s\n",e.what()); }
    return 1;
}
