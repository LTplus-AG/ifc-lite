// SPDX-License-Identifier: MPL-2.0
#include "protocol.h"
#include <cstdlib>
#include <cstring>
// Request and returned response are distinct owned allocations. A nonzero return
// poisons this module incarnation: the host must discard its Worker.
extern "C" int ifclite_smlib_dispatch_owned(const uint8_t* request, uint32_t size,
    uint8_t** response, uint32_t* response_size) {
    if (!response || !response_size) return 1;
    *response=nullptr; *response_size=0;
    if (!request || size < 12 || size > 4096) return 1;
    try {
        const std::vector<uint8_t> frame(request,request+size);
        const auto result=ifclite_smlib_dispatch(frame);
        auto* allocation=static_cast<uint8_t*>(std::malloc(result.size()));
        if (!allocation) return 2;
        std::memcpy(allocation,result.data(),result.size());
        *response=allocation; *response_size=uint32_t(result.size());
        return 0;
    } catch (...) { return 1; }
}
