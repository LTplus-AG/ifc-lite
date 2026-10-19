/* SPDX-License-Identifier: MPL-2.0 */
#include "ifclite_smlib.h"
_Static_assert(sizeof(ifclite_smlib_handle) == 16, "handle ABI size");
_Static_assert(sizeof(ifclite_smlib_status) == 4, "status ABI size");
_Static_assert(sizeof(ifclite_smlib_session) == 8, "session ABI size");
_Static_assert(sizeof(ifclite_smlib_mesh_info) == 24, "mesh info ABI size");
_Static_assert(sizeof(ifclite_smlib_rectangle_edge) == 248, "rectangle edge fixed C layout");
_Static_assert(sizeof(ifclite_smlib_rectangle_domain) == 1376, "rectangle fixed C layout");
uint32_t header_works_in_c(void) { return ifclite_smlib_abi_version(); }
