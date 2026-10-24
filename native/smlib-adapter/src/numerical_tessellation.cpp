// SPDX-License-Identifier: MPL-2.0
#include "representation_seal.hpp"
#include "edge_subdivision.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include "context_metadata.hpp"
#include <SmApiBrep.h>
#include <cmath>
namespace face_lineage {
void NumericalRead::begin_tessellation(Ledger& ledger,SmBrep& source) {
    const auto nodes=ledger.node_count,events=ledger.event_count;
    ledger.prepare_read_storage();
    begin(ledger,source); ledger.numerical.tessellation=true;
    ledger.numerical.retained_nodes=nodes; ledger.numerical.retained_events=events;
    ledger.subdivision=std::make_unique<EdgeSubdivision>(ledger,source);
}
void NumericalRead::release_tessellation_history(Ledger& ledger,SmPolyBrep* output) {
    ledger.reclaim_tessellation_history(output);
}
SmStatus NumericalRead::tessellate(Ledger& ledger,SmBrep& source,SmPolyBrep*& output,
    const SmTessellationParams& params,SmTessellationReport& report) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"tessellation read refused after terminal isolation failure"};
    if(!source.GetContext() || output || !std::isfinite(params.dChordHeightTol) || params.dChordHeightTol<=0 ||
        !std::isfinite(params.dCurveAngleTolDeg) || params.dCurveAngleTolDeg<=0 || params.dCurveAngleTolDeg>180 ||
        !std::isfinite(params.dSurfaceAngleTolDeg) || params.dSurfaceAngleTolDeg<=0 || params.dSurfaceAngleTolDeg>180)
        throw AdapterFailure{IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid owned tessellation-read inputs"};
    auto& context=*const_cast<SmContext*>(source.GetContext()); raw_context::Restore restore(&context);
    Scope phase(ledger,context,&source); RepresentationSeal seal(ledger,source);
    try {
        begin_tessellation(ledger,source);
        const auto status=SmApiTessellate(&source,output,params,FALSE,nullptr,&report);
        // A successful SDK status cannot override a callback refusal. All
        // copied helpers must retire before the seal/inventory and publication.
        ledger.check(); end(ledger); seal.verify(); ledger.verify_inventory(source);
        if(status!=SM_SUCCESS || report.failures.GetSize())
            throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"owned tessellation read failed or was partial"};
        release_tessellation_history(ledger,output);
        phase.finish(); ledger.check(); return status;
    } catch(...) {
        ledger.numerical.source=nullptr;
        // No partial output or cleanup through an uncertain kernel domain.
        output=nullptr;
        rethrow_tainted_kernel_domain("fixed SDK tessellation read");
    }
}
}
