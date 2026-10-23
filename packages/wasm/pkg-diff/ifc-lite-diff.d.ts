/* tslint:disable */
/* eslint-disable */

export class DiffModel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compare this base model with a head model, returning row-index records.
     * No JS reference is serialized, cloned, or retained inside WASM.
     */
    compare(head: DiffModel, options: any): any;
    /**
     * Create an owned model from columnar buffers. Call free() when finished;
     * a model may participate in any number of comparisons before that.
     */
    constructor(strings: any, fields: Uint32Array, flags: Uint8Array, boxes: Float64Array, volumes: Float64Array, component_offsets: Uint32Array, component_pairs: Uint32Array);
    readonly entityCount: number;
}

/**
 * Component hashes share the canonical Rust attribute projection.
 */
export function diffBuildComponentFingerprints(input: any): any;

/**
 * Hash adapter data directly in Rust without a JSON text round trip.
 */
export function diffBuildDataFingerprint(input: any): string;

/**
 * Normalize, deduplicate and validate an identity or lineage sidecar.
 */
export function diffCreateSidecar(text: string, lineage: boolean): string;

/**
 * Return head/base pairs in JavaScript Map insertion order.
 */
export function diffKeyAliasesFromLineage(value: any): any;

/**
 * Return ordered conflict diagnostics for caller-supplied lineage entries.
 */
export function diffLineageConflicts(value: any): string[];

/**
 * Migrate keys using Rust policies, preserving the absence of orphan relations.
 */
export function diffRekeyByLineage(keys: string[], value: any, deleted: string[], policy: string): any;

/**
 * Emit JSON.stringify-compatible pretty bytes and the trailing newline.
 */
export function diffSerializeSidecar(text: string): string;

/**
 * Raw code units preserve JS strings that cannot be represented as Rust UTF-8.
 */
export function diffStableHash(units: Uint16Array): string;

/**
 * Host decoding preserves lone UTF-16 units even inside conflict diagnostics.
 */
export function diffValidateSidecar(text: string, lineage: boolean): string[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_diffmodel_free: (a: number, b: number) => void;
    readonly diffBuildComponentFingerprints: (a: number, b: number) => void;
    readonly diffBuildDataFingerprint: (a: number, b: number) => void;
    readonly diffCreateSidecar: (a: number, b: number, c: number, d: number) => void;
    readonly diffKeyAliasesFromLineage: (a: number, b: number) => void;
    readonly diffLineageConflicts: (a: number, b: number) => void;
    readonly diffRekeyByLineage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly diffSerializeSidecar: (a: number, b: number, c: number) => void;
    readonly diffStableHash: (a: number, b: number, c: number) => void;
    readonly diffValidateSidecar: (a: number, b: number, c: number, d: number) => void;
    readonly diffmodel_compare: (a: number, b: number, c: number, d: number) => void;
    readonly diffmodel_entityCount: (a: number) => number;
    readonly diffmodel_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
