/* SPDX-License-Identifier: MPL-2.0 */
#ifndef IFCLITE_SMLIB_H
#define IFCLITE_SMLIB_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define IFCLITE_SMLIB_ABI_VERSION 1u
typedef uint64_t ifclite_smlib_session;
typedef struct ifclite_smlib_handle {
    uint64_t session;
    uint32_t slot;
    uint32_t generation;
} ifclite_smlib_handle;
typedef int32_t ifclite_smlib_status;
typedef struct ifclite_smlib_mesh_info {
    uint32_t vertex_count, triangle_count, source_face_count;
    uint32_t boundary_edges, spine_edges, failed_faces;
} ifclite_smlib_mesh_info;
#define IFCLITE_SMLIB_OK 0
#define IFCLITE_SMLIB_INVALID_ARGUMENT 1
#define IFCLITE_SMLIB_INVALID_SESSION 2
#define IFCLITE_SMLIB_INVALID_HANDLE 3
#define IFCLITE_SMLIB_KERNEL_ERROR 4
#define IFCLITE_SMLIB_EXCEPTION 5
#define IFCLITE_SMLIB_RESOURCE_LIMIT 6
#define IFCLITE_SMLIB_UNSUPPORTED 7
#define IFCLITE_SMLIB_UNION 1u
#define IFCLITE_SMLIB_INTERSECTION 2u
#define IFCLITE_SMLIB_DIFFERENCE 3u
#define IFCLITE_SMLIB_POSITIONS 1u
#define IFCLITE_SMLIB_INDICES 2u
#define IFCLITE_SMLIB_SOURCE_FACES 3u
#define IFCLITE_SMLIB_NORMALS 4u

/* All calls across ALL sessions must be serialized by the caller. Sessions own
 * solids, not independent SMLib contexts. Process/module lifetime owns context.
 * Output pointers must address caller-owned valid memory; null is rejected.
 * Handles are values, never pointers. No C++ allocation crosses this boundary.
 * Status-returning calls clear last error; error_copy preserves it.
 */
uint32_t ifclite_smlib_abi_version(void);
ifclite_smlib_status ifclite_smlib_session_create(ifclite_smlib_session* out);
ifclite_smlib_status ifclite_smlib_session_destroy(ifclite_smlib_session session);
/* Origin is minimum box corner; cylinder extends along positive Z. */
ifclite_smlib_status ifclite_smlib_box(ifclite_smlib_session session,
    double x, double y, double z, double width, double depth, double height,
    ifclite_smlib_handle* out);
ifclite_smlib_status ifclite_smlib_cylinder(ifclite_smlib_session session,
    double x, double y, double z, double radius, double height,
    ifclite_smlib_handle* out);
/* Copies both operands before invoking destructive upstream operations.
 * Inputs remain owned and unchanged on success and reported failure. */
ifclite_smlib_status ifclite_smlib_boolean(ifclite_smlib_session session,
    ifclite_smlib_handle left, ifclite_smlib_handle right, uint32_t operation,
    ifclite_smlib_handle* out);
/* Relative numerical-integration tolerance, supported range [1e-8, 1e-1]. */
ifclite_smlib_status ifclite_smlib_volume(ifclite_smlib_session session,
    ifclite_smlib_handle solid, double integration_tolerance, double* out);
ifclite_smlib_status ifclite_smlib_manifold(ifclite_smlib_session session,
    ifclite_smlib_handle solid, uint32_t* out);
ifclite_smlib_status ifclite_smlib_release(ifclite_smlib_session session,
    ifclite_smlib_handle solid);
/* Strict tessellation. Positive chord in model units and angle in (0,180].
 * Source face IDs are local GetFaces() indices of this retained BRep revision,
 * not IFC IDs or durable topological identities. Returned mesh is separately owned. */
ifclite_smlib_status ifclite_smlib_tessellate(ifclite_smlib_session session,
    ifclite_smlib_handle solid, double chord, double angle, ifclite_smlib_handle* out);
ifclite_smlib_status ifclite_smlib_mesh_get_info(ifclite_smlib_session session,
    ifclite_smlib_handle mesh, ifclite_smlib_mesh_info* out);
/* Streams use native ABI scalar layout: f64 XYZ positions, u32 triangle indices,
 * u32 source face per triangle, f64 flat per-corner XYZ normals. Offset/count are
 * scalars, not vertices. Copies at most 480 scalars into caller-owned memory.
 * Capacity is bytes; no buffer is borrowed. output alignment need not be natural. */
ifclite_smlib_status ifclite_smlib_mesh_copy(ifclite_smlib_session session,
    ifclite_smlib_handle mesh, uint32_t stream, uint32_t offset, uint32_t count,
    void* out, uint32_t capacity_bytes);
/* Additive extension negotiation, independent of unchanged ABI/protocol v1.
 * Bit 0: staged sweep recipe format 1. One upload/session; max 1MiB/8192 curves/128 loops.
 * Recipe LE: u32 format,loops,segments,reserved; f64 unit direction XYZ,depth;
 * per loop u32 role(0 outer first,1 inner thereafter),count; per curve u32 kind,reserved and 12 f64.
 * Line(1): start XYZ,end XYZ,6 zeros. Circle(2): center XYZ,normal XYZ,
 * x-axis XYZ,radius,start radians,signed sweep radians (+/-2pi). Arc(3): same
 * fields with a partial signed interval. XY profiles; normal +/-Z, unit XY
 * x-axis. Multiple loops require outer CCW, holes CW. Units are local metres.
 * Extended regions are implemented but remain unqualified pending SDK receipts;
 * source admission must retain its own qualification gates.
 * Begin declares exact size/counts. Chunks are sequential and <=3840 bytes.
 * Invalid chunks discard the transaction; each matching commit with non-null output consumes it,
 * including incomplete/failed commits. Null output leaves the upload active. Abort/session destroy clean incomplete input.
 * New solids publish only after capped sweep manifold/volume checks. */
uint32_t ifclite_smlib_capabilities(void);
ifclite_smlib_status ifclite_smlib_sweep_begin(uint64_t session, uint32_t format,
    uint32_t length, uint32_t loops, uint32_t segments, uint64_t* out);
ifclite_smlib_status ifclite_smlib_sweep_chunk(uint64_t session, uint64_t upload,
    uint32_t offset, const uint8_t* bytes, uint32_t length);
ifclite_smlib_status ifclite_smlib_sweep_abort(uint64_t session, uint64_t upload);
ifclite_smlib_status ifclite_smlib_sweep_commit(uint64_t session, uint64_t upload,
    ifclite_smlib_handle* out);
/* Returns required bytes INCLUDING NUL. Copies a terminated, possibly truncated
 * message when capacity > 0 and buffer != NULL. Buffer may be NULL for sizing. */
uint32_t ifclite_smlib_error_copy(char* buffer, uint32_t capacity);
#ifdef __cplusplus
}
#endif
#endif
