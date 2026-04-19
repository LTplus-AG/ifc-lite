let wasm;

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

let heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

function __wasm_bindgen_func_elem_1126(arg0, arg1, arg2) {
    wasm.__wasm_bindgen_func_elem_1126(arg0, arg1, addHeapObject(arg2));
}

function __wasm_bindgen_func_elem_1166(arg0, arg1, arg2, arg3) {
    wasm.__wasm_bindgen_func_elem_1166(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3));
}

const GeoReferenceJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_georeferencejs_free(ptr >>> 0, 1));

const GpuGeometryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gpugeometry_free(ptr >>> 0, 1));

const GpuInstancedGeometryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gpuinstancedgeometry_free(ptr >>> 0, 1));

const GpuInstancedGeometryCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gpuinstancedgeometrycollection_free(ptr >>> 0, 1));

const GpuInstancedGeometryRefFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gpuinstancedgeometryref_free(ptr >>> 0, 1));

const GpuMeshMetadataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gpumeshmetadata_free(ptr >>> 0, 1));

const IfcAPIFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ifcapi_free(ptr >>> 0, 1));

const InstanceDataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_instancedata_free(ptr >>> 0, 1));

const InstancedGeometryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_instancedgeometry_free(ptr >>> 0, 1));

const InstancedMeshCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_instancedmeshcollection_free(ptr >>> 0, 1));

const MeshCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshcollection_free(ptr >>> 0, 1));

const MeshCollectionWithRtcFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshcollectionwithrtc_free(ptr >>> 0, 1));

const MeshDataJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshdatajs_free(ptr >>> 0, 1));

const ProfileCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profilecollection_free(ptr >>> 0, 1));

const ProfileEntryJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profileentryjs_free(ptr >>> 0, 1));

const RtcOffsetJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rtcoffsetjs_free(ptr >>> 0, 1));

const SymbolicCircleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symboliccircle_free(ptr >>> 0, 1));

const SymbolicPolylineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolicpolyline_free(ptr >>> 0, 1));

const SymbolicRepresentationCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolicrepresentationcollection_free(ptr >>> 0, 1));

const ZeroCopyMeshFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zerocopymesh_free(ptr >>> 0, 1));

/**
 * Georeferencing information exposed to JavaScript
 */
export class GeoReferenceJs {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GeoReferenceJs.prototype);
        obj.__wbg_ptr = ptr;
        GeoReferenceJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GeoReferenceJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_georeferencejs_free(ptr, 0);
    }
    /**
     * Transform local coordinates to map coordinates
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float64Array}
     */
    localToMap(x, y, z) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.georeferencejs_localToMap(retptr, this.__wbg_ptr, x, y, z);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Transform map coordinates to local coordinates
     * @param {number} e
     * @param {number} n
     * @param {number} h
     * @returns {Float64Array}
     */
    mapToLocal(e, n, h) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.georeferencejs_mapToLocal(retptr, this.__wbg_ptr, e, n, h);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get CRS name
     * @returns {string | undefined}
     */
    get crsName() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.georeferencejs_crsName(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export2(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get rotation angle in radians
     * @returns {number}
     */
    get rotation() {
        const ret = wasm.georeferencejs_rotation(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get 4x4 transformation matrix (column-major for WebGL)
     * @returns {Float64Array}
     */
    toMatrix() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.georeferencejs_toMatrix(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Eastings (X offset)
     * @returns {number}
     */
    get eastings() {
        const ret = wasm.__wbg_get_georeferencejs_eastings(this.__wbg_ptr);
        return ret;
    }
    /**
     * Eastings (X offset)
     * @param {number} arg0
     */
    set eastings(arg0) {
        wasm.__wbg_set_georeferencejs_eastings(this.__wbg_ptr, arg0);
    }
    /**
     * Northings (Y offset)
     * @returns {number}
     */
    get northings() {
        const ret = wasm.__wbg_get_georeferencejs_northings(this.__wbg_ptr);
        return ret;
    }
    /**
     * Northings (Y offset)
     * @param {number} arg0
     */
    set northings(arg0) {
        wasm.__wbg_set_georeferencejs_northings(this.__wbg_ptr, arg0);
    }
    /**
     * Orthogonal height (Z offset)
     * @returns {number}
     */
    get orthogonal_height() {
        const ret = wasm.__wbg_get_georeferencejs_orthogonal_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * Orthogonal height (Z offset)
     * @param {number} arg0
     */
    set orthogonal_height(arg0) {
        wasm.__wbg_set_georeferencejs_orthogonal_height(this.__wbg_ptr, arg0);
    }
    /**
     * X-axis abscissa (cos of rotation)
     * @returns {number}
     */
    get x_axis_abscissa() {
        const ret = wasm.__wbg_get_georeferencejs_x_axis_abscissa(this.__wbg_ptr);
        return ret;
    }
    /**
     * X-axis abscissa (cos of rotation)
     * @param {number} arg0
     */
    set x_axis_abscissa(arg0) {
        wasm.__wbg_set_georeferencejs_x_axis_abscissa(this.__wbg_ptr, arg0);
    }
    /**
     * X-axis ordinate (sin of rotation)
     * @returns {number}
     */
    get x_axis_ordinate() {
        const ret = wasm.__wbg_get_georeferencejs_x_axis_ordinate(this.__wbg_ptr);
        return ret;
    }
    /**
     * X-axis ordinate (sin of rotation)
     * @param {number} arg0
     */
    set x_axis_ordinate(arg0) {
        wasm.__wbg_set_georeferencejs_x_axis_ordinate(this.__wbg_ptr, arg0);
    }
    /**
     * Scale factor
     * @returns {number}
     */
    get scale() {
        const ret = wasm.__wbg_get_georeferencejs_scale(this.__wbg_ptr);
        return ret;
    }
    /**
     * Scale factor
     * @param {number} arg0
     */
    set scale(arg0) {
        wasm.__wbg_set_georeferencejs_scale(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) GeoReferenceJs.prototype[Symbol.dispose] = GeoReferenceJs.prototype.free;

/**
 * GPU-ready geometry stored in WASM linear memory
 *
 * Data layout:
 * - vertex_data: Interleaved [px, py, pz, nx, ny, nz, ...] (6 floats per vertex)
 * - indices: Triangle indices [i0, i1, i2, ...]
 * - mesh_metadata: Per-mesh metadata for draw calls
 *
 * All coordinates are pre-converted from IFC Z-up to WebGL Y-up
 */
export class GpuGeometry {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GpuGeometry.prototype);
        obj.__wbg_ptr = ptr;
        GpuGeometryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GpuGeometryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gpugeometry_free(ptr, 0);
    }
    /**
     * Get number of meshes in this geometry batch
     * @returns {number}
     */
    get meshCount() {
        const ret = wasm.gpugeometry_meshCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get length of indices array (in u32 elements)
     * @returns {number}
     */
    get indicesLen() {
        const ret = wasm.gpugeometry_indicesLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get pointer to indices array for zero-copy view
     * @returns {number}
     */
    get indicesPtr() {
        const ret = wasm.gpugeometry_indicesPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get X component of RTC offset
     * @returns {number}
     */
    get rtcOffsetX() {
        const ret = wasm.gpugeometry_rtcOffsetX(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get Y component of RTC offset
     * @returns {number}
     */
    get rtcOffsetY() {
        const ret = wasm.gpugeometry_rtcOffsetY(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get Z component of RTC offset
     * @returns {number}
     */
    get rtcOffsetZ() {
        const ret = wasm.gpugeometry_rtcOffsetZ(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if RTC offset is active (non-zero)
     * @returns {boolean}
     */
    get hasRtcOffset() {
        const ret = wasm.gpugeometry_hasRtcOffset(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Set the RTC (Relative To Center) offset applied to coordinates
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    set_rtc_offset(x, y, z) {
        wasm.gpugeometry_set_rtc_offset(this.__wbg_ptr, x, y, z);
    }
    /**
     * Get length of vertex data array (in f32 elements, not bytes)
     * @returns {number}
     */
    get vertexDataLen() {
        const ret = wasm.gpugeometry_vertexDataLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get pointer to vertex data for zero-copy view
     *
     * SAFETY: View is only valid until next WASM allocation!
     * Create view, upload to GPU, then discard view immediately.
     * @returns {number}
     */
    get vertexDataPtr() {
        const ret = wasm.gpugeometry_vertexDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get IFC type name by index
     * @param {number} index
     * @returns {string | undefined}
     */
    getIfcTypeName(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.gpugeometry_getIfcTypeName(retptr, this.__wbg_ptr, index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export2(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get metadata for a specific mesh
     * @param {number} index
     * @returns {GpuMeshMetadata | undefined}
     */
    getMeshMetadata(index) {
        const ret = wasm.gpugeometry_getMeshMetadata(this.__wbg_ptr, index);
        return ret === 0 ? undefined : GpuMeshMetadata.__wrap(ret);
    }
    /**
     * Get total vertex count
     * @returns {number}
     */
    get totalVertexCount() {
        const ret = wasm.gpugeometry_totalVertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get byte length of indices (for GPU buffer creation)
     * @returns {number}
     */
    get indicesByteLength() {
        const ret = wasm.gpugeometry_indicesByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get total triangle count
     * @returns {number}
     */
    get totalTriangleCount() {
        const ret = wasm.gpugeometry_totalTriangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get byte length of vertex data (for GPU buffer creation)
     * @returns {number}
     */
    get vertexDataByteLength() {
        const ret = wasm.gpugeometry_vertexDataByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a new empty GPU geometry container
     */
    constructor() {
        const ret = wasm.gpugeometry_new();
        this.__wbg_ptr = ret >>> 0;
        GpuGeometryFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Check if geometry is empty
     * @returns {boolean}
     */
    get isEmpty() {
        const ret = wasm.gpugeometry_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) GpuGeometry.prototype[Symbol.dispose] = GpuGeometry.prototype.free;

/**
 * GPU-ready instanced geometry for efficient rendering of repeated shapes
 *
 * Data layout:
 * - vertex_data: Interleaved [px, py, pz, nx, ny, nz, ...] (shared geometry)
 * - indices: Triangle indices (shared geometry)
 * - instance_data: [transform (16 floats) + color (4 floats)] per instance = 20 floats
 */
export class GpuInstancedGeometry {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GpuInstancedGeometry.prototype);
        obj.__wbg_ptr = ptr;
        GpuInstancedGeometryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GpuInstancedGeometryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gpuinstancedgeometry_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get geometryId() {
        const ret = wasm.gpuinstancedgeometry_geometryId(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get indicesLen() {
        const ret = wasm.gpuinstancedgeometry_indicesLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get indicesPtr() {
        const ret = wasm.gpuinstancedgeometry_indicesPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexCount() {
        const ret = wasm.gpuinstancedgeometry_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceCount() {
        const ret = wasm.gpuinstancedgeometry_instanceCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get triangleCount() {
        const ret = wasm.gpuinstancedgeometry_triangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataLen() {
        const ret = wasm.gpuinstancedgeometry_vertexDataLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataPtr() {
        const ret = wasm.gpuinstancedgeometry_vertexDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataLen() {
        const ret = wasm.gpuinstancedgeometry_instanceDataLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataPtr() {
        const ret = wasm.gpuinstancedgeometry_instanceDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get indicesByteLength() {
        const ret = wasm.gpuinstancedgeometry_indicesByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataByteLength() {
        const ret = wasm.gpuinstancedgeometry_vertexDataByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceExpressIdsPtr() {
        const ret = wasm.gpuinstancedgeometry_instanceExpressIdsPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataByteLength() {
        const ret = wasm.gpuinstancedgeometry_instanceDataByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create new instanced geometry
     * @param {bigint} geometry_id
     */
    constructor(geometry_id) {
        const ret = wasm.gpuinstancedgeometry_new(geometry_id);
        this.__wbg_ptr = ret >>> 0;
        GpuInstancedGeometryFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) GpuInstancedGeometry.prototype[Symbol.dispose] = GpuInstancedGeometry.prototype.free;

/**
 * Collection of GPU-ready instanced geometries
 */
export class GpuInstancedGeometryCollection {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GpuInstancedGeometryCollection.prototype);
        obj.__wbg_ptr = ptr;
        GpuInstancedGeometryCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GpuInstancedGeometryCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gpuinstancedgeometrycollection_free(ptr, 0);
    }
    /**
     * @param {number} index
     * @returns {GpuInstancedGeometry | undefined}
     */
    get(index) {
        const ret = wasm.gpuinstancedgeometrycollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : GpuInstancedGeometry.__wrap(ret);
    }
    constructor() {
        const ret = wasm.gpuinstancedgeometrycollection_new();
        this.__wbg_ptr = ret >>> 0;
        GpuInstancedGeometryCollectionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get length() {
        const ret = wasm.gpuinstancedgeometrycollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get geometry by index with pointer access over owned buffers.
     * This avoids exposing references tied to collection lifetime.
     * @param {number} index
     * @returns {GpuInstancedGeometryRef | undefined}
     */
    getRef(index) {
        const ret = wasm.gpuinstancedgeometrycollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : GpuInstancedGeometryRef.__wrap(ret);
    }
}
if (Symbol.dispose) GpuInstancedGeometryCollection.prototype[Symbol.dispose] = GpuInstancedGeometryCollection.prototype.free;

/**
 * Pointer-friendly geometry view with owned backing storage.
 * Owning buffers prevents dangling pointers after collection mutation/drop.
 */
export class GpuInstancedGeometryRef {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GpuInstancedGeometryRef.prototype);
        obj.__wbg_ptr = ptr;
        GpuInstancedGeometryRefFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GpuInstancedGeometryRefFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gpuinstancedgeometryref_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get geometryId() {
        const ret = wasm.gpuinstancedgeometry_geometryId(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get indicesLen() {
        const ret = wasm.gpuinstancedgeometry_indicesLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get indicesPtr() {
        const ret = wasm.gpuinstancedgeometry_indicesPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceCount() {
        const ret = wasm.gpuinstancedgeometry_instanceCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataLen() {
        const ret = wasm.gpuinstancedgeometry_vertexDataLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataPtr() {
        const ret = wasm.gpuinstancedgeometry_vertexDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataLen() {
        const ret = wasm.gpuinstancedgeometry_instanceDataLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataPtr() {
        const ret = wasm.gpuinstancedgeometry_instanceDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get indicesByteLength() {
        const ret = wasm.gpuinstancedgeometry_indicesByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexDataByteLength() {
        const ret = wasm.gpuinstancedgeometry_vertexDataByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceExpressIdsPtr() {
        const ret = wasm.gpuinstancedgeometry_instanceExpressIdsPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get instanceDataByteLength() {
        const ret = wasm.gpuinstancedgeometry_instanceDataByteLength(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) GpuInstancedGeometryRef.prototype[Symbol.dispose] = GpuInstancedGeometryRef.prototype.free;

/**
 * Metadata for a single mesh within the GPU geometry buffer
 */
export class GpuMeshMetadata {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(GpuMeshMetadata.prototype);
        obj.__wbg_ptr = ptr;
        GpuMeshMetadataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GpuMeshMetadataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gpumeshmetadata_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.gpumeshmetadata_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get indexCount() {
        const ret = wasm.gpumeshmetadata_indexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get ifcTypeIdx() {
        const ret = wasm.gpumeshmetadata_ifcTypeIdx(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get indexOffset() {
        const ret = wasm.gpumeshmetadata_indexOffset(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexCount() {
        const ret = wasm.gpumeshmetadata_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get vertexOffset() {
        const ret = wasm.gpumeshmetadata_vertexOffset(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get color() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.gpumeshmetadata_color(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) GpuMeshMetadata.prototype[Symbol.dispose] = GpuMeshMetadata.prototype.free;

/**
 * Main IFC-Lite API
 */
export class IfcAPI {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IfcAPIFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ifcapi_free(ptr, 0);
    }
    /**
     * Parse IFC file and return individual meshes with express IDs and colors
     * This matches the MeshData[] format expected by the viewer
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const collection = api.parseMeshes(ifcData);
     * for (let i = 0; i < collection.length; i++) {
     *   const mesh = collection.get(i);
     *   console.log('Express ID:', mesh.expressId);
     *   console.log('Positions:', mesh.positions);
     *   console.log('Color:', mesh.color);
     * }
     * ```
     * @param {string} content
     * @returns {MeshCollection}
     */
    parseMeshes(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshes(this.__wbg_ptr, ptr0, len0);
        return MeshCollection.__wrap(ret);
    }
    /**
     * Parse IFC file with streaming mesh batches for progressive rendering
     * Calls the callback with batches of meshes, yielding to browser between batches
     *
     * Options:
     * - `batchSize`: Number of meshes per batch (default: 25)
     * - `onBatch(meshes, progress)`: Called for each batch of meshes
     * - `onRtcOffset({x, y, z, hasRtc})`: Called early with RTC offset for camera/world setup
     * - `onColorUpdate(Map<id, color>)`: Called with style updates after initial render
     * - `onComplete(stats)`: Called when parsing completes with stats including rtcOffset
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * await api.parseMeshesAsync(ifcData, {
     *   batchSize: 100,
     *   onRtcOffset: (rtc) => {
     *     if (rtc.hasRtc) {
     *       // Model uses large coordinates - adjust camera/world origin
     *       viewer.setWorldOffset(rtc.x, rtc.y, rtc.z);
     *     }
     *   },
     *   onBatch: (meshes, progress) => {
     *     for (const mesh of meshes) {
     *       scene.add(createThreeMesh(mesh));
     *     }
     *     console.log(`Progress: ${progress.percent}%`);
     *   },
     *   onComplete: (stats) => {
     *     console.log(`Done! ${stats.totalMeshes} meshes`);
     *     // stats.rtcOffset also available here: {x, y, z, hasRtc}
     *   }
     * });
     * ```
     * @param {string} content
     * @param {any} options
     * @returns {Promise<any>}
     */
    parseMeshesAsync(content, options) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshesAsync(this.__wbg_ptr, ptr0, len0, addHeapObject(options));
        return takeObject(ret);
    }
    /**
     * Fast pre-pass: scans for geometry entities ONLY (skips style/void/material resolution).
     * Returns job list + unit scale + RTC offset in ~1-2s instead of ~6s.
     * Geometry workers can start immediately with default colors + no void subtraction.
     * A parallel style worker can run buildPrePassOnce for correct colors later.
     * @param {Uint8Array} data
     * @returns {any}
     */
    buildPrePassFast(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_buildPrePassFast(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Run the pre-pass ONCE and return serialized results for worker distribution.
     * Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
     * @param {Uint8Array} data
     * @returns {any}
     */
    buildPrePassOnce(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_buildPrePassOnce(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Parse a subset of IFC geometry entities by index range.
     *
     * Performs the full pre-pass (entity index, combined style/void/brep scan)
     * but only processes geometry entities whose index (in the combined
     * simple + complex job list) falls within `[start_idx, end_idx)`.
     *
     * This enables Web Worker parallelization: each worker processes a
     * disjoint slice of the entity list while sharing the same pre-pass data.
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * // Worker 1: entities 0..500
     * const batch1 = api.parseMeshesSubset(content, 0, 500);
     * // Worker 2: entities 500..1000
     * const batch2 = api.parseMeshesSubset(content, 500, 1000);
     * ```
     * @param {string} content
     * @param {number} start_idx
     * @param {number} end_idx
     * @param {boolean} skip_expensive
     * @returns {MeshCollection}
     */
    parseMeshesSubset(content, start_idx, end_idx, skip_expensive) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshesSubset(this.__wbg_ptr, ptr0, len0, start_idx, end_idx, skip_expensive);
        return MeshCollection.__wrap(ret);
    }
    /**
     * Parse IFC file and return GPU-ready geometry for zero-copy upload
     *
     * This method generates geometry that is:
     * - Pre-interleaved (position + normal per vertex)
     * - Coordinate-converted (Z-up to Y-up)
     * - Ready for direct GPU upload via pointer access
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const gpuGeom = api.parseToGpuGeometry(ifcData);
     *
     * // Get WASM memory for zero-copy views
     * const memory = api.getMemory();
     *
     * // Create views directly into WASM memory (NO COPY!)
     * const vertexView = new Float32Array(
     *   memory.buffer,
     *   gpuGeom.vertexDataPtr,
     *   gpuGeom.vertexDataLen
     * );
     * const indexView = new Uint32Array(
     *   memory.buffer,
     *   gpuGeom.indicesPtr,
     *   gpuGeom.indicesLen
     * );
     *
     * // Upload directly to GPU (single copy: WASM → GPU)
     * device.queue.writeBuffer(vertexBuffer, 0, vertexView);
     * device.queue.writeBuffer(indexBuffer, 0, indexView);
     *
     * // Free when done
     * gpuGeom.free();
     * ```
     * @param {string} content
     * @returns {GpuGeometry}
     */
    parseToGpuGeometry(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseToGpuGeometry(this.__wbg_ptr, ptr0, len0);
        return GpuGeometry.__wrap(ret);
    }
    /**
     * Parse IFC file and return instanced geometry grouped by geometry hash
     * This reduces draw calls by grouping identical geometries with different transforms
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const collection = api.parseMeshesInstanced(ifcData);
     * for (let i = 0; i < collection.length; i++) {
     *   const geometry = collection.get(i);
     *   console.log('Geometry ID:', geometry.geometryId);
     *   console.log('Instances:', geometry.instanceCount);
     *   for (let j = 0; j < geometry.instanceCount; j++) {
     *     const inst = geometry.getInstance(j);
     *     console.log('  Express ID:', inst.expressId);
     *     console.log('  Transform:', inst.transform);
     *   }
     * }
     * ```
     * @param {string} content
     * @returns {InstancedMeshCollection}
     */
    parseMeshesInstanced(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshesInstanced(this.__wbg_ptr, ptr0, len0);
        return InstancedMeshCollection.__wrap(ret);
    }
    /**
     * Process geometry for a subset of pre-scanned entities.
     * Takes raw bytes and pre-pass data from buildPrePassOnce.
     * @param {Uint8Array} data
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @returns {MeshCollection}
     */
    processGeometryBatch(data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export3);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(void_values, wasm.__wbindgen_export3);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export3);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export3);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processGeometryBatch(this.__wbg_ptr, ptr0, len0, ptr1, len1, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
        return MeshCollection.__wrap(ret);
    }
    /**
     * Parse IFC file with streaming GPU-ready geometry batches
     *
     * Yields batches of GPU-ready geometry for progressive rendering with zero-copy upload.
     * Uses fast-first-frame streaming: simple geometry (walls, slabs) first.
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const memory = api.getMemory();
     *
     * await api.parseToGpuGeometryAsync(ifcData, {
     *   batchSize: 25,
     *   onBatch: (gpuGeom, progress) => {
     *     // Create zero-copy views
     *     const vertexView = new Float32Array(
     *       memory.buffer,
     *       gpuGeom.vertexDataPtr,
     *       gpuGeom.vertexDataLen
     *     );
     *
     *     // Upload to GPU
     *     device.queue.writeBuffer(vertexBuffer, 0, vertexView);
     *
     *     // IMPORTANT: Free immediately after upload!
     *     gpuGeom.free();
     *   },
     *   onComplete: (stats) => {
     *     console.log(`Done! ${stats.totalMeshes} meshes`);
     *   }
     * });
     * ```
     * @param {string} content
     * @param {any} options
     * @returns {Promise<any>}
     */
    parseToGpuGeometryAsync(content, options) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseToGpuGeometryAsync(this.__wbg_ptr, ptr0, len0, addHeapObject(options));
        return takeObject(ret);
    }
    /**
     * Parse IFC file with streaming instanced geometry batches for progressive rendering
     * Groups identical geometries and yields batches of InstancedGeometry
     * Uses fast-first-frame streaming: simple geometry (walls, slabs) first
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * await api.parseMeshesInstancedAsync(ifcData, {
     *   batchSize: 25,  // Number of unique geometries per batch
     *   onBatch: (geometries, progress) => {
     *     for (const geom of geometries) {
     *       renderer.addInstancedGeometry(geom);
     *     }
     *   },
     *   onComplete: (stats) => {
     *     console.log(`Done! ${stats.totalGeometries} unique geometries, ${stats.totalInstances} instances`);
     *   }
     * });
     * ```
     * @param {string} content
     * @param {any} options
     * @returns {Promise<any>}
     */
    parseMeshesInstancedAsync(content, options) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshesInstancedAsync(this.__wbg_ptr, ptr0, len0, addHeapObject(options));
        return takeObject(ret);
    }
    /**
     * Parse IFC file to GPU-ready instanced geometry for zero-copy upload
     *
     * Groups identical geometries by hash for efficient GPU instancing.
     * Returns a collection of instanced geometries with pointer access.
     * @param {string} content
     * @returns {GpuInstancedGeometryCollection}
     */
    parseToGpuInstancedGeometry(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseToGpuInstancedGeometry(this.__wbg_ptr, ptr0, len0);
        return GpuInstancedGeometryCollection.__wrap(ret);
    }
    /**
     * Process instanced geometry for a subset of pre-scanned entities.
     * Takes raw bytes and pre-pass data from buildPrePassOnce.
     * @param {Uint8Array} data
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @returns {InstancedMeshCollection}
     */
    processInstancedGeometryBatch(data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, style_ids, style_colors) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export3);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processInstancedGeometryBatch(this.__wbg_ptr, ptr0, len0, ptr1, len1, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr2, len2, ptr3, len3);
        return InstancedMeshCollection.__wrap(ret);
    }
    /**
     * Parse IFC file with zero-copy mesh data
     * Maximum performance - returns mesh with direct memory access
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const mesh = await api.parseZeroCopy(ifcData);
     *
     * // Create TypedArray views (NO COPYING!)
     * const memory = await api.getMemory();
     * const positions = new Float32Array(
     *   memory.buffer,
     *   mesh.positions_ptr,
     *   mesh.positions_len
     * );
     *
     * // Upload directly to GPU
     * gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
     * ```
     * @param {string} content
     * @returns {ZeroCopyMesh}
     */
    parseZeroCopy(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseZeroCopy(this.__wbg_ptr, ptr0, len0);
        return ZeroCopyMesh.__wrap(ret);
    }
    /**
     * Extract raw profile polygons from all building elements with `IfcExtrudedAreaSolid`
     * representations.
     *
     * Returns a [`ProfileCollection`] whose entries each carry:
     * - A 2D polygon (outer + holes) in local profile space (metres)
     * - A 4 × 4 column-major transform in WebGL Y-up world space
     * - Extrusion direction (world space) and depth (metres)
     *
     * Use [`ProfileProjector`] (TypeScript) to convert these into `DrawingLine[]`
     * for clean projection without tessellation artifacts.
     *
     * ```javascript
     * const api = new IfcAPI();
     * const profiles = api.extractProfiles(ifcContent, 0);
     * console.log('Profiles:', profiles.length);
     * for (let i = 0; i < profiles.length; i++) {
     *   const p = profiles.get(i);
     *   console.log(p.ifcType, 'depth:', p.extrusionDepth);
     * }
     * ```
     * @param {string} content
     * @param {number} model_index
     * @returns {ProfileCollection}
     */
    extractProfiles(content, model_index) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_extractProfiles(this.__wbg_ptr, ptr0, len0, model_index);
        return ProfileCollection.__wrap(ret);
    }
    /**
     * Debug: Test processing entity #953 (FacetedBrep wall)
     * @param {string} content
     * @returns {string}
     */
    debugProcessEntity953(content) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_debugProcessEntity953(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Debug: Test processing a single wall
     * @param {string} content
     * @returns {string}
     */
    debugProcessFirstWall(content) {
        let deferred2_0;
        let deferred2_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_debugProcessFirstWall(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred2_0 = r0;
            deferred2_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Get WASM memory for zero-copy access
     * @returns {any}
     */
    getMemory() {
        const ret = wasm.ifcapi_getMemory(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Clear the cached entity index (call after streaming is complete)
     */
    clearPrePassCache() {
        wasm.ifcapi_clearPrePassCache(this.__wbg_ptr);
    }
    /**
     * Create and initialize the IFC API
     */
    constructor() {
        const ret = wasm.ifcapi_new();
        this.__wbg_ptr = ret >>> 0;
        IfcAPIFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get version string
     * @returns {string}
     */
    get version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.ifcapi_version(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if API is initialized
     * @returns {boolean}
     */
    get is_ready() {
        const ret = wasm.ifcapi_is_ready(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Extract georeferencing information from IFC content
     * Returns null if no georeferencing is present
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const georef = api.getGeoReference(ifcData);
     * if (georef) {
     *   console.log('CRS:', georef.crsName);
     *   const [e, n, h] = georef.localToMap(10, 20, 5);
     * }
     * ```
     * @param {string} content
     * @returns {GeoReferenceJs | undefined}
     */
    getGeoReference(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_getGeoReference(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : GeoReferenceJs.__wrap(ret);
    }
    /**
     * Parse IFC file and return mesh with RTC offset for large coordinates
     * This handles georeferenced models by shifting to centroid
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const result = api.parseMeshesWithRtc(ifcData);
     * const rtcOffset = result.rtcOffset;
     * const meshes = result.meshes;
     *
     * // Convert local coords back to world:
     * if (rtcOffset.isSignificant()) {
     *   const [wx, wy, wz] = rtcOffset.toWorld(localX, localY, localZ);
     * }
     * ```
     * @param {string} content
     * @returns {MeshCollectionWithRtc}
     */
    parseMeshesWithRtc(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseMeshesWithRtc(this.__wbg_ptr, ptr0, len0);
        return MeshCollectionWithRtc.__wrap(ret);
    }
    /**
     * Parse IFC file with streaming events
     * Calls the callback function for each parse event
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * await api.parseStreaming(ifcData, (event) => {
     *   console.log('Event:', event);
     * });
     * ```
     * @param {string} content
     * @param {Function} callback
     * @returns {Promise<any>}
     */
    parseStreaming(content, callback) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseStreaming(this.__wbg_ptr, ptr0, len0, addHeapObject(callback));
        return takeObject(ret);
    }
    /**
     * Fast entity scanning using SIMD-accelerated Rust scanner
     * Returns array of entity references for data model parsing
     * Much faster than TypeScript byte-by-byte scanning (5-10x speedup)
     * @param {string} content
     * @returns {any}
     */
    scanEntitiesFast(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanEntitiesFast(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Fast entity scanning from raw bytes (avoids TextDecoder.decode on JS side).
     * Accepts Uint8Array directly — saves ~2-5s for 487MB files by skipping
     * JS string creation and UTF-16→UTF-8 conversion.
     * @param {Uint8Array} data
     * @returns {any}
     */
    scanEntitiesFastBytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanEntitiesFastBytes(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Fast geometry-only entity scanning
     * Scans only entities that have geometry, skipping 99% of non-geometry entities
     * Returns array of geometry entity references for parallel processing
     * Much faster than scanning all entities (3x speedup for large files)
     * @param {string} content
     * @returns {any}
     */
    scanGeometryEntitiesFast(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanGeometryEntitiesFast(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Fast scan that only returns metadata-relevant entity refs.
     * This drastically reduces transfer size for huge-file metadata hydration.
     * @param {Uint8Array} data
     * @returns {any}
     */
    scanRelevantEntitiesFastBytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanRelevantEntitiesFastBytes(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Parse IFC file (traditional - waits for completion)
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const result = await api.parse(ifcData);
     * console.log('Entities:', result.entityCount);
     * ```
     * @param {string} content
     * @returns {Promise<any>}
     */
    parse(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parse(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Parse IFC file and extract symbolic representations (Plan, Annotation, FootPrint)
     * These are 2D curves used for architectural drawings instead of sectioning 3D geometry
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const symbols = api.parseSymbolicRepresentations(ifcData);
     * console.log('Found', symbols.totalCount, 'symbolic items');
     * for (let i = 0; i < symbols.polylineCount; i++) {
     *   const polyline = symbols.getPolyline(i);
     *   console.log('Polyline for', polyline.ifcType, ':', polyline.points);
     * }
     * ```
     * @param {string} content
     * @returns {SymbolicRepresentationCollection}
     */
    parseSymbolicRepresentations(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseSymbolicRepresentations(this.__wbg_ptr, ptr0, len0);
        return SymbolicRepresentationCollection.__wrap(ret);
    }
}
if (Symbol.dispose) IfcAPI.prototype[Symbol.dispose] = IfcAPI.prototype.free;

/**
 * Instance data for instanced rendering
 */
export class InstanceData {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(InstanceData.prototype);
        obj.__wbg_ptr = ptr;
        InstanceDataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InstanceDataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_instancedata_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.instancedata_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get color() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.instancedata_color(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float32Array}
     */
    get transform() {
        const ret = wasm.instancedata_transform(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) InstanceData.prototype[Symbol.dispose] = InstanceData.prototype.free;

/**
 * Instanced geometry - one geometry definition with multiple instances
 */
export class InstancedGeometry {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(InstancedGeometry.prototype);
        obj.__wbg_ptr = ptr;
        InstancedGeometryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InstancedGeometryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_instancedgeometry_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get geometryId() {
        const ret = wasm.gpuinstancedgeometry_geometryId(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {number} index
     * @returns {InstanceData | undefined}
     */
    get_instance(index) {
        const ret = wasm.instancedgeometry_get_instance(this.__wbg_ptr, index);
        return ret === 0 ? undefined : InstanceData.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get instance_count() {
        const ret = wasm.instancedgeometry_instance_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.instancedgeometry_indices(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {Float32Array}
     */
    get normals() {
        const ret = wasm.instancedgeometry_normals(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.instancedgeometry_positions(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) InstancedGeometry.prototype[Symbol.dispose] = InstancedGeometry.prototype.free;

/**
 * Collection of instanced geometries
 */
export class InstancedMeshCollection {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(InstancedMeshCollection.prototype);
        obj.__wbg_ptr = ptr;
        InstancedMeshCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InstancedMeshCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_instancedmeshcollection_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get totalInstances() {
        const ret = wasm.instancedmeshcollection_totalInstances(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get totalGeometries() {
        const ret = wasm.gpuinstancedgeometrycollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} index
     * @returns {InstancedGeometry | undefined}
     */
    get(index) {
        const ret = wasm.instancedmeshcollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : InstancedGeometry.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get length() {
        const ret = wasm.gpuinstancedgeometrycollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) InstancedMeshCollection.prototype[Symbol.dispose] = InstancedMeshCollection.prototype.free;

/**
 * Collection of mesh data for returning multiple meshes
 */
export class MeshCollection {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MeshCollection.prototype);
        obj.__wbg_ptr = ptr;
        MeshCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshcollection_free(ptr, 0);
    }
    /**
     * Get RTC offset X (for converting local coords back to world coords)
     * Add this to local X coordinates to get world X coordinates
     * @returns {number}
     */
    get rtcOffsetX() {
        const ret = wasm.gpugeometry_rtcOffsetZ(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get RTC offset Y
     * @returns {number}
     */
    get rtcOffsetY() {
        const ret = wasm.meshcollection_rtcOffsetY(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get RTC offset Z
     * @returns {number}
     */
    get rtcOffsetZ() {
        const ret = wasm.meshcollection_rtcOffsetZ(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if RTC offset is significant (>10km)
     * @returns {boolean}
     */
    hasRtcOffset() {
        const ret = wasm.meshcollection_hasRtcOffset(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Convert local coordinates to world coordinates
     * Use this to convert mesh positions back to original IFC coordinates
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float64Array}
     */
    localToWorld(x, y, z) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshcollection_localToWorld(retptr, this.__wbg_ptr, x, y, z);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get total vertex count across all meshes
     * @returns {number}
     */
    get totalVertices() {
        const ret = wasm.meshcollection_totalVertices(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get total triangle count across all meshes
     * @returns {number}
     */
    get totalTriangles() {
        const ret = wasm.meshcollection_totalTriangles(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get building rotation angle in radians (from IfcSite placement)
     * Returns None if no rotation was detected
     * @returns {number | undefined}
     */
    get buildingRotation() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshcollection_buildingRotation(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r2 = getDataViewMemory0().getFloat64(retptr + 8 * 1, true);
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get mesh at index
     * @param {number} index
     * @returns {MeshDataJs | undefined}
     */
    get(index) {
        const ret = wasm.meshcollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : MeshDataJs.__wrap(ret);
    }
    /**
     * Get number of meshes
     * @returns {number}
     */
    get length() {
        const ret = wasm.meshcollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) MeshCollection.prototype[Symbol.dispose] = MeshCollection.prototype.free;

/**
 * Mesh collection with RTC offset for large coordinates
 */
export class MeshCollectionWithRtc {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MeshCollectionWithRtc.prototype);
        obj.__wbg_ptr = ptr;
        MeshCollectionWithRtcFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshCollectionWithRtcFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshcollectionwithrtc_free(ptr, 0);
    }
    /**
     * Get the RTC offset
     * @returns {RtcOffsetJs}
     */
    get rtcOffset() {
        const ret = wasm.meshcollectionwithrtc_rtcOffset(this.__wbg_ptr);
        return RtcOffsetJs.__wrap(ret);
    }
    /**
     * Get mesh at index
     * @param {number} index
     * @returns {MeshDataJs | undefined}
     */
    get(index) {
        const ret = wasm.meshcollectionwithrtc_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : MeshDataJs.__wrap(ret);
    }
    /**
     * Get number of meshes
     * @returns {number}
     */
    get length() {
        const ret = wasm.meshcollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the mesh collection
     * @returns {MeshCollection}
     */
    get meshes() {
        const ret = wasm.meshcollectionwithrtc_meshes(this.__wbg_ptr);
        return MeshCollection.__wrap(ret);
    }
}
if (Symbol.dispose) MeshCollectionWithRtc.prototype[Symbol.dispose] = MeshCollectionWithRtc.prototype.free;

/**
 * Individual mesh data with express ID and color (matches MeshData interface)
 */
export class MeshDataJs {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(MeshDataJs.prototype);
        obj.__wbg_ptr = ptr;
        MeshDataJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshDataJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshdatajs_free(ptr, 0);
    }
    /**
     * Get express ID
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.meshdatajs_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get vertex count
     * @returns {number}
     */
    get vertexCount() {
        const ret = wasm.meshdatajs_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get triangle count
     * @returns {number}
     */
    get triangleCount() {
        const ret = wasm.meshdatajs_triangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get color as [r, g, b, a] array
     * @returns {Float32Array}
     */
    get color() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_color(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get indices as Uint32Array (copy to JS)
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.meshdatajs_indices(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get normals as Float32Array (copy to JS)
     * @returns {Float32Array}
     */
    get normals() {
        const ret = wasm.meshdatajs_normals(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get IFC type name (e.g., "IfcWall", "IfcSpace")
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get positions as Float32Array (copy to JS)
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.meshdatajs_positions(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) MeshDataJs.prototype[Symbol.dispose] = MeshDataJs.prototype.free;

/**
 * A collection of extracted profiles.
 */
export class ProfileCollection {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProfileCollection.prototype);
        obj.__wbg_ptr = ptr;
        ProfileCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profilecollection_free(ptr, 0);
    }
    /**
     * Get profile at `index`.  Returns `undefined` for out-of-bounds index.
     * @param {number} index
     * @returns {ProfileEntryJs | undefined}
     */
    get(index) {
        const ret = wasm.profilecollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : ProfileEntryJs.__wrap(ret);
    }
    /**
     * Number of profiles.
     * @returns {number}
     */
    get length() {
        const ret = wasm.profilecollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ProfileCollection.prototype[Symbol.dispose] = ProfileCollection.prototype.free;

/**
 * A single profile entry – raw 2D polygon + world transform.
 *
 * Profile points are in **local 2D profile space** (metres).
 * Apply `transform` to `[x, y, 0, 1]` to get WebGL Y-up world coordinates.
 */
export class ProfileEntryJs {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProfileEntryJs.prototype);
        obj.__wbg_ptr = ptr;
        ProfileEntryJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileEntryJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profileentryjs_free(ptr, 0);
    }
    /**
     * Express ID of the building element.
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.meshdatajs_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of points per hole.
     * @returns {Uint32Array}
     */
    get holeCounts() {
        const ret = wasm.profileentryjs_holeCounts(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * All hole points concatenated: `[x0, y0, x1, y1, …]` (metres).
     * @returns {Float32Array}
     */
    get holePoints() {
        const ret = wasm.profileentryjs_holePoints(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Model index for multi-model federation.
     * @returns {number}
     */
    get modelIndex() {
        const ret = wasm.profileentryjs_modelIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Outer boundary: flat `[x0, y0, x1, y1, …]` in local profile space (metres).
     * @returns {Float32Array}
     */
    get outerPoints() {
        const ret = wasm.profileentryjs_outerPoints(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Extrusion direction `[dx, dy, dz]` in WebGL Y-up world space (unit vector).
     * @returns {Float32Array}
     */
    get extrusionDir() {
        const ret = wasm.profileentryjs_extrusionDir(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Extrusion depth (metres).
     * @returns {number}
     */
    get extrusionDepth() {
        const ret = wasm.profileentryjs_extrusionDepth(this.__wbg_ptr);
        return ret;
    }
    /**
     * IFC type name (e.g., `"IfcWall"`).
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.profileentryjs_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * 4 × 4 column-major transform in WebGL Y-up world space.
     * `M * [x, y, 0, 1]ᵀ` gives the world position.
     * @returns {Float32Array}
     */
    get transform() {
        const ret = wasm.profileentryjs_transform(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) ProfileEntryJs.prototype[Symbol.dispose] = ProfileEntryJs.prototype.free;

/**
 * RTC offset information exposed to JavaScript
 */
export class RtcOffsetJs {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RtcOffsetJs.prototype);
        obj.__wbg_ptr = ptr;
        RtcOffsetJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RtcOffsetJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rtcoffsetjs_free(ptr, 0);
    }
    /**
     * Check if offset is significant (>10km)
     * @returns {boolean}
     */
    isSignificant() {
        const ret = wasm.rtcoffsetjs_isSignificant(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Convert local coordinates to world coordinates
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float64Array}
     */
    toWorld(x, y, z) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.rtcoffsetjs_toWorld(retptr, this.__wbg_ptr, x, y, z);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * X offset (subtracted from positions)
     * @returns {number}
     */
    get x() {
        const ret = wasm.__wbg_get_georeferencejs_eastings(this.__wbg_ptr);
        return ret;
    }
    /**
     * X offset (subtracted from positions)
     * @param {number} arg0
     */
    set x(arg0) {
        wasm.__wbg_set_georeferencejs_eastings(this.__wbg_ptr, arg0);
    }
    /**
     * Y offset
     * @returns {number}
     */
    get y() {
        const ret = wasm.__wbg_get_georeferencejs_northings(this.__wbg_ptr);
        return ret;
    }
    /**
     * Y offset
     * @param {number} arg0
     */
    set y(arg0) {
        wasm.__wbg_set_georeferencejs_northings(this.__wbg_ptr, arg0);
    }
    /**
     * Z offset
     * @returns {number}
     */
    get z() {
        const ret = wasm.__wbg_get_georeferencejs_orthogonal_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * Z offset
     * @param {number} arg0
     */
    set z(arg0) {
        wasm.__wbg_set_georeferencejs_orthogonal_height(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) RtcOffsetJs.prototype[Symbol.dispose] = RtcOffsetJs.prototype.free;

/**
 * A 2D circle/arc for symbolic representations
 */
export class SymbolicCircle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SymbolicCircle.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicCircleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicCircleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symboliccircle_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.gpumeshmetadata_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get startAngle() {
        const ret = wasm.symboliccircle_startAngle(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if this is a full circle
     * @returns {boolean}
     */
    get isFullCircle() {
        const ret = wasm.symboliccircle_isFullCircle(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symboliccircle_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get radius() {
        const ret = wasm.symboliccircle_radius(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get centerX() {
        const ret = wasm.symboliccircle_centerX(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get centerY() {
        const ret = wasm.symboliccircle_centerY(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symboliccircle_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get endAngle() {
        const ret = wasm.symboliccircle_endAngle(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SymbolicCircle.prototype[Symbol.dispose] = SymbolicCircle.prototype.free;

/**
 * A single 2D polyline for symbolic representations (Plan, Annotation, FootPrint)
 * Points are stored as [x1, y1, x2, y2, ...] in 2D coordinates
 */
export class SymbolicPolyline {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SymbolicPolyline.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicPolylineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicPolylineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolicpolyline_free(ptr, 0);
    }
    /**
     * Get express ID of the parent element
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.symbolicpolyline_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of points
     * @returns {number}
     */
    get pointCount() {
        const ret = wasm.symbolicpolyline_pointCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get representation identifier ("Plan", "Annotation", "FootPrint", "Axis")
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicpolyline_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get 2D points as Float32Array [x1, y1, x2, y2, ...]
     * @returns {Float32Array}
     */
    get points() {
        const ret = wasm.symbolicpolyline_points(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get IFC type name (e.g., "IfcDoor", "IfcWindow")
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicpolyline_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if this is a closed loop
     * @returns {boolean}
     */
    get isClosed() {
        const ret = wasm.symbolicpolyline_isClosed(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) SymbolicPolyline.prototype[Symbol.dispose] = SymbolicPolyline.prototype.free;

/**
 * Collection of symbolic representations for an IFC model
 */
export class SymbolicRepresentationCollection {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SymbolicRepresentationCollection.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicRepresentationCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicRepresentationCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolicrepresentationcollection_free(ptr, 0);
    }
    /**
     * Get circle at index
     * @param {number} index
     * @returns {SymbolicCircle | undefined}
     */
    getCircle(index) {
        const ret = wasm.symbolicrepresentationcollection_getCircle(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicCircle.__wrap(ret);
    }
    /**
     * Get total count of all symbolic items
     * @returns {number}
     */
    get totalCount() {
        const ret = wasm.symbolicrepresentationcollection_totalCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of circles/arcs
     * @returns {number}
     */
    get circleCount() {
        const ret = wasm.symbolicrepresentationcollection_circleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get polyline at index
     * @param {number} index
     * @returns {SymbolicPolyline | undefined}
     */
    getPolyline(index) {
        const ret = wasm.symbolicrepresentationcollection_getPolyline(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicPolyline.__wrap(ret);
    }
    /**
     * Get number of polylines
     * @returns {number}
     */
    get polylineCount() {
        const ret = wasm.symbolicrepresentationcollection_polylineCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get all express IDs that have symbolic representations
     * @returns {Uint32Array}
     */
    getExpressIds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicrepresentationcollection_getExpressIds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Check if collection is empty
     * @returns {boolean}
     */
    get isEmpty() {
        const ret = wasm.symbolicrepresentationcollection_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) SymbolicRepresentationCollection.prototype[Symbol.dispose] = SymbolicRepresentationCollection.prototype.free;

/**
 * Zero-copy mesh that exposes pointers to WASM memory
 */
export class ZeroCopyMesh {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ZeroCopyMesh.prototype);
        obj.__wbg_ptr = ptr;
        ZeroCopyMeshFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ZeroCopyMeshFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zerocopymesh_free(ptr, 0);
    }
    /**
     * Get bounding box maximum point
     * @returns {Float32Array}
     */
    bounds_max() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zerocopymesh_bounds_max(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get bounding box minimum point
     * @returns {Float32Array}
     */
    bounds_min() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zerocopymesh_bounds_min(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get length of indices array
     * @returns {number}
     */
    get indices_len() {
        const ret = wasm.gpuinstancedgeometry_indicesLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get pointer to indices array
     * @returns {number}
     */
    get indices_ptr() {
        const ret = wasm.gpuinstancedgeometry_indicesPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get length of normals array
     * @returns {number}
     */
    get normals_len() {
        const ret = wasm.zerocopymesh_normals_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get pointer to normals array
     * @returns {number}
     */
    get normals_ptr() {
        const ret = wasm.gpuinstancedgeometry_vertexDataPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get vertex count
     * @returns {number}
     */
    get vertex_count() {
        const ret = wasm.zerocopymesh_vertex_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get length of positions array (in f32 elements, not bytes)
     * @returns {number}
     */
    get positions_len() {
        const ret = wasm.zerocopymesh_positions_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get pointer to positions array
     * JavaScript can create Float32Array view: new Float32Array(memory.buffer, ptr, length)
     * @returns {number}
     */
    get positions_ptr() {
        const ret = wasm.zerocopymesh_positions_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get triangle count
     * @returns {number}
     */
    get triangle_count() {
        const ret = wasm.gpuinstancedgeometry_triangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a new zero-copy mesh from a Mesh
     */
    constructor() {
        const ret = wasm.zerocopymesh_new();
        this.__wbg_ptr = ret >>> 0;
        ZeroCopyMeshFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Check if mesh is empty
     * @returns {boolean}
     */
    get is_empty() {
        const ret = wasm.zerocopymesh_is_empty(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) ZeroCopyMesh.prototype[Symbol.dispose] = ZeroCopyMesh.prototype.free;

/**
 * Get WASM memory to allow JavaScript to create TypedArray views
 * @returns {any}
 */
export function get_memory() {
    const ret = wasm.get_memory();
    return takeObject(ret);
}

/**
 * Initialize the WASM module.
 *
 * This function is called automatically when the WASM module is loaded.
 * It sets up panic hooks for better error messages in the browser console.
 */
export function init() {
    wasm.init();
}

/**
 * Get the version of IFC-Lite.
 *
 * # Returns
 *
 * Version string (e.g., "0.1.0")
 *
 * # Example
 *
 * ```javascript
 * console.log(`IFC-Lite version: ${version()}`);
 * ```
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
    }
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
        const ret = typeof(getObject(arg0)) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
        const ret = getObject(arg0) === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_memory_a342e963fbcabd68 = function() {
        const ret = wasm.memory;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg___wbindgen_number_get_9619185a74197f95 = function(arg0, arg1) {
        const obj = getObject(arg1);
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = function(arg0) {
        getObject(arg0)._wbg_cb_unref();
    };
    imports.wbg.__wbg_call_3020136f7a2d6e44 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_call_abb4ff46ce38be40 = function() { return handleError(function (arg0, arg1) {
        const ret = getObject(arg0).call(getObject(arg1));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_call_c8baa5c5e72d274e = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_debug_9d0c87ddda3dc485 = function(arg0) {
        console.debug(getObject(arg0));
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_export2(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_get_af9dab7e9603ea93 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(getObject(arg0), getObject(arg1));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_gpugeometry_new = function(arg0) {
        const ret = GpuGeometry.__wrap(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_instancedgeometry_new = function(arg0) {
        const ret = InstancedGeometry.__wrap(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_length_86ce4877baf913bb = function(arg0) {
        const ret = getObject(arg0).length;
        return ret;
    };
    imports.wbg.__wbg_length_d45040a40c570362 = function(arg0) {
        const ret = getObject(arg0).length;
        return ret;
    };
    imports.wbg.__wbg_meshdatajs_new = function(arg0) {
        const ret = MeshDataJs.__wrap(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
        const ret = new Object();
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_25f239778d6112b9 = function() {
        const ret = new Array();
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_ff12d2b041fb48f1 = function(arg0, arg1) {
        try {
            var state0 = {a: arg0, b: arg1};
            var cb0 = (arg0, arg1) => {
                const a = state0.a;
                state0.a = 0;
                try {
                    return __wasm_bindgen_func_elem_1166(a, state0.b, arg0, arg1);
                } finally {
                    state0.a = a;
                }
            };
            const ret = new Promise(cb0);
            return addHeapObject(ret);
        } finally {
            state0.a = state0.b = 0;
        }
    };
    imports.wbg.__wbg_new_from_slice_41e2764a343e3cb1 = function(arg0, arg1) {
        const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_from_slice_db0691b69e9d3891 = function(arg0, arg1) {
        const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_with_length_202b3db94ba5fc86 = function(arg0) {
        const ret = new Uint32Array(arg0 >>> 0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_with_length_806b9e5b8290af7c = function(arg0) {
        const ret = new Float64Array(arg0 >>> 0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_with_length_aa5eaf41d35235e5 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_prototypesetcall_96cc7097487b926d = function(arg0, arg1, arg2) {
        Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), getObject(arg2));
    };
    imports.wbg.__wbg_push_7d9be8f38fc13975 = function(arg0, arg1) {
        const ret = getObject(arg0).push(getObject(arg1));
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_9b549dfce8865860 = function(arg0) {
        const ret = getObject(arg0).queueMicrotask;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_queueMicrotask_fca69f5bfad613a5 = function(arg0) {
        queueMicrotask(getObject(arg0));
    };
    imports.wbg.__wbg_resolve_fd5bfbaa4ce36e1e = function(arg0) {
        const ret = Promise.resolve(getObject(arg0));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
    };
    imports.wbg.__wbg_set_781438a03c0c3c81 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
        getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
    };
    imports.wbg.__wbg_set_index_021489b2916af13e = function(arg0, arg1, arg2) {
        getObject(arg0)[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_index_04c4b93e64d08a52 = function(arg0, arg1, arg2) {
        getObject(arg0)[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_index_42abe35f117e614e = function(arg0, arg1, arg2) {
        getObject(arg0)[arg1 >>> 0] = arg2 >>> 0;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = getObject(arg1).stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_then_4f95312d68691235 = function(arg0, arg1) {
        const ret = getObject(arg0).then(getObject(arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_warn_6e567d0d926ff881 = function(arg0) {
        console.warn(getObject(arg0));
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
        // Cast intrinsic for `U64 -> Externref`.
        const ret = BigInt.asUintN(64, arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_cast_d1f2d19555106100 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 150, function: Function { arguments: [Externref], shim_idx: 151, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_1125, __wasm_bindgen_func_elem_1126);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_clone_ref = function(arg0) {
        const ret = getObject(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('ifc-lite_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
