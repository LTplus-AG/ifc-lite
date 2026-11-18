/* tslint:disable */
/* eslint-disable */

export interface CityJsonExportJs {
    text: string;
    /** `metadata.referenceSystem`, or null for local coordinates. */
    referenceSystem: string | null;
    warnings: string[];
    buildings: number;
    cityObjects: number;
    vertices: number;
}



/**
 * Encoded Rhino scene. Getters copy data out so the handle can be freed immediately.
 */
export class RhinoSceneJs {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly blob: Uint8Array;
    readonly manifest: string;
}

/**
 * Export `content` as CityJSON 2.0 (or CityJSONSeq with `sequence`).
 *
 * A model with no `IfcBuilding` throws an `Error` whose message starts with
 * `CITYJSON_REFUSED:`. Georeferencing that cannot be resolved is not an
 * error: the document is written in local coordinates and `warnings` says why.
 */
export function exportCityJson(content: Uint8Array, options_json: string): CityJsonExportJs;

/**
 * Build the shared Rhino scene; archive writing belongs to the adapter.
 * A model with no render geometry throws an `Error` whose message starts with
 * `NO_RENDER_GEOMETRY`, like the default engine's `exportUsd`.
 */
export function exportRhinoScene(content: Uint8Array, options_json: string): RhinoSceneJs;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_rhinoscenejs_free: (a: number, b: number) => void;
    readonly exportCityJson: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly exportRhinoScene: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rhinoscenejs_blob: (a: number) => number;
    readonly rhinoscenejs_manifest: (a: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
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
