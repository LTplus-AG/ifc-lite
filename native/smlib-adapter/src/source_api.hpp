// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "source_evidence.hpp"
// Private protocol v1 source extension; the public C ABI stays unchanged.
int32_t source_commit(uint64_t session,uint64_t upload,face_lineage::SourceStamp,ifclite_smlib_handle*);
int32_t source_info(uint64_t session,ifclite_smlib_handle,uint8_t* bytes,uint32_t capacity,uint32_t* length);
