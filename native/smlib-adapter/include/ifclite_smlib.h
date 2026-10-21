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
/* SDK failure may leave unlinked internal allocations: discard the entire
 * process/module. No subsequent status-returning operation is permitted.
 * Existing ABI/protocol layouts are unchanged; this is an additive status. */
#define IFCLITE_SMLIB_TAINTED_DOMAIN 8
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
/* Copies the BRep before transforming; input remains immutable on all outcomes.
 * Matrix has 16 column-major doubles: finite positive rigid affine only. */
ifclite_smlib_status ifclite_smlib_transform(ifclite_smlib_session session,
    ifclite_smlib_handle solid, const double* matrix, ifclite_smlib_handle* out);
/* Bounded general affine copy into a generic rational BRep (opcode 18,
 * capability bit 4, numeric 16); rigid ifclite_smlib_transform is unchanged.
 * Matrix: 16 column-major doubles, |entry|<=1e9, last row exactly 0,0,0,1,
 * nonsingular (else status 1); singular values in [1e-6,1e6] and condition
 * number <=1e6 (else status 7). Only these source classes convert exactly:
 * curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola and surface
 * BSpline/Plane/Cylinder/Cone/Sphere/Torus with materialized rational data
 * owned by their own edge/face. Anything else (offsets, composites, shared
 * geometry, knots the SDK copy would normalize) refuses with status 7 before
 * any copy; the source is never modified. A failure after copying starts
 * returns status 8 (tainted domain). The certificate counts unique source
 * geometry objects per class in that order: an exact rationalizable
 * representation conversion with floating-point transformation, not exact
 * arithmetic, durable face identity or execution qualification. The copy is
 * owned independently of its source. Policy and SDK sources: src/affine.cpp. */
typedef struct ifclite_smlib_affine_certificate {
    uint32_t version, representation, source_classes[12];
} ifclite_smlib_affine_certificate;
ifclite_smlib_status ifclite_smlib_copy_affine(ifclite_smlib_session session,
    ifclite_smlib_handle solid, const double* matrix, ifclite_smlib_handle* out,
    ifclite_smlib_affine_certificate* certificate);
/* Relative numerical-integration tolerance, supported range [1e-8, 1e-1]. */
ifclite_smlib_status ifclite_smlib_volume(ifclite_smlib_session session,
    ifclite_smlib_handle solid, double integration_tolerance, double* out);
ifclite_smlib_status ifclite_smlib_manifold(ifclite_smlib_session session,
    ifclite_smlib_handle solid, uint32_t* out);
/* Semantic emptiness of the actual retained solid: no boundary or lower-
 * dimensional topology and only known-void regions (a material or UNSURE
 * infinite region is full space, not empty). Not a mesh or volume heuristic.
 * Writes exactly 0 or 1; the solid is not consumed. Strict tessellation of a
 * solid certified empty yields an owned mesh whose six counts are all zero.
 * Additive opcode 19, capability bit 5 (numeric 32). */
ifclite_smlib_status ifclite_smlib_is_empty(ifclite_smlib_session session,
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
 * Bit 0 (numeric 1): staged sweep recipe format 1 (ordered planar region).
 * Bit 1 (numeric 2): staged format 2 capped open rational-path solid disk.
 * Bit 3 (numeric 8): copied rigid transform.
 * Bit 4 (numeric 16): bounded affine rational copy (opcode 18).
 * Bit 5 (numeric 32): semantic empty query (opcode 19). Capability indicates
 * implementation, never execution qualification. */
#define IFCLITE_SMLIB_CAPABILITY_SWEEP_REGION 1u
#define IFCLITE_SMLIB_CAPABILITY_SWEEP_DISK 2u
#define IFCLITE_SMLIB_CAPABILITY_RIGID_COPY 8u
#define IFCLITE_SMLIB_CAPABILITY_AFFINE_COPY 16u
#define IFCLITE_SMLIB_CAPABILITY_SEMANTIC_EMPTY 32u
uint32_t ifclite_smlib_capabilities(void);
/* Staged authored recipes, local metres. One upload per session; at most
 * 1 MiB, 8192 curves and 128 loops.
 * Format 1 LE: u32 format,loops,segments,reserved; f64 unit direction XYZ,depth;
 * per loop u32 role (0 outer first, 1 inner thereafter),count; per curve u32
 * kind,reserved and 12 f64. Line(1): start XYZ,end XYZ,6 zeros. Circle(2):
 * centre XYZ,normal XYZ,x-axis XYZ,radius,start radians,signed sweep (+/-2pi).
 * Arc(3): same fields with a partial signed interval. XY profiles; normal +/-Z,
 * unit XY x-axis. Multiple loops require outer CCW, holes CW.
 * Format 2 LE: u32 2,1,1,0; f64 radius,inner radius (0); u32 kind 4,0,degree,
 * control count,unique knot count,0; f64 trim start,end; per control f64 XYZ,
 * weight; per unique knot f64 knot,u32 multiplicity,u32 0. Open paths only.
 * Begin declares exact size/counts. Chunks are sequential and <=3840 bytes.
 * An invalid chunk discards the transaction. Each matching commit with
 * non-null output consumes it, including incomplete/failed commits; null
 * output leaves the upload active. Abort/session destroy discard incomplete
 * input. New solids publish only after manifold/positive-volume checks. */
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
