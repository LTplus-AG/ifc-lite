/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript → JavaScript transpilation for the QuickJS sandbox.
 *
 * Strategy:
 * 1. Use esbuild-wasm for full TypeScript support (lazy-loaded, ~10MB WASM)
 * 2. Fallback: improved regex-based type stripping
 *
 * After transpilation, import/export statements are stripped since QuickJS
 * has no module system — scripts use the global `bim` object.
 */

// ============================================================================
// esbuild-wasm (primary transpiler)
// ============================================================================

interface EsbuildLike {
  initialize: (options: { wasmURL?: string; worker?: boolean }) => Promise<void>;
  transform: (code: string, options: { loader: string; target: string }) => Promise<{ code: string }>;
}

export type TranspileMode = 'esbuild' | 'fallback-ts' | 'fallback-js';

let lastTranspileMode: TranspileMode = 'esbuild';
let fallbackWarningShown = false;

export function getLastTranspileMode(): TranspileMode {
  return lastTranspileMode;
}

let esbuildReady: Promise<EsbuildLike | null> | null = null;

/**
 * Lazy-load and initialize esbuild-wasm.
 * First script run pays the ~10MB WASM download; subsequent runs are instant.
 * Returns null if unavailable (WASM blocked, CDN down, etc.).
 */
function getEsbuild(): Promise<EsbuildLike | null> {
  if (esbuildReady) return esbuildReady;
  esbuildReady = (async () => {
    try {
      // Dynamic import — Vite code-splits esbuild-wasm into a separate chunk
      const mod = await import('esbuild-wasm');
      const esbuild = (mod.default ?? mod) as EsbuildLike;

      // Resolve WASM binary URL
      let wasmURL: string | undefined;
      try {
        // Vite: import the .wasm as a URL asset (works in dev + production).
        // The `?url` suffix is a Vite-specific resolver hint that older TS
        // versions errored on; current versions resolve it via the bundler
        // module-resolution mode without needing @ts-expect-error.
        const wasmMod = await import('esbuild-wasm/esbuild.wasm?url' as string);
        wasmURL = (wasmMod as { default: string }).default;
      } catch {
        // Fallback: CDN (version-pinned to match installed package)
        wasmURL = `https://unpkg.com/esbuild-wasm@0.27.3/esbuild.wasm`;
      }

      await esbuild.initialize({ wasmURL, worker: false });
      return esbuild;
    } catch {
      return null;
    }
  })();
  return esbuildReady;
}

// ============================================================================
// Public API
// ============================================================================

/** Transpile TypeScript to JavaScript by stripping types, then strip imports */
export async function transpileTypeScript(code: string): Promise<string> {
  let js: string;
  const isLikelyTypeScript = looksLikeTypeScript(code);

  try {
    const esbuild = await getEsbuild();
    if (esbuild) {
      const result = await esbuild.transform(code, {
        loader: 'ts',
        target: 'es2022',
      });
      js = result.code;
      lastTranspileMode = 'esbuild';
    } else {
      // Fallback mode: only strip types when the input actually looks like TS.
      // Running naive stripping on plain JS can corrupt object literals
      // (e.g. `Position: [0,0,0]` -> `Position`) and cause runtime errors.
      js = isLikelyTypeScript ? naiveTypeStrip(code) : code;
      lastTranspileMode = isLikelyTypeScript ? 'fallback-ts' : 'fallback-js';
      if (!fallbackWarningShown) {
        fallbackWarningShown = true;
        console.warn('[ifc-lite/sandbox] esbuild unavailable, using fallback transpiler');
      }
    }
  } catch {
    js = isLikelyTypeScript ? naiveTypeStrip(code) : code;
    lastTranspileMode = isLikelyTypeScript ? 'fallback-ts' : 'fallback-js';
    if (!fallbackWarningShown) {
      fallbackWarningShown = true;
      console.warn('[ifc-lite/sandbox] esbuild failed, using fallback transpiler');
    }
  }

  // Strip import/export statements — QuickJS has no module system
  return stripModuleSyntax(js);
}

/**
 * Conservative TS detector used only for fallback mode when esbuild isn't available.
 * We intentionally avoid broad `:` heuristics because they collide with JS object literals.
 */
function looksLikeTypeScript(code: string): boolean {
  return (
    /\binterface\s+\w+/.test(code) ||
    /\btype\s+\w+\s*=/.test(code) ||
    /\b(?:as)\s+[A-Za-z_]\w*(?:\[\])?/.test(code) ||
    /\b(?:const|let|var)\s+\w+\s*:\s*[A-Za-z_]/.test(code) ||
    /\b(?:async\s+)?(?:function\s+\w+\s*)?\([^()]*\b\w+\s*:\s*[A-Za-z_][\w<>,\s[\]|]*\)\s*(?::\s*[A-Za-z_][\w<>,\s[\]|]*)?\s*(?:=>|\{)/.test(code) ||
    /\([^)]*:\s*(?:string|number|boolean|void|any|unknown|never|Record<|Array<|Map<|Set<)/.test(code) ||
    /\)\s*:\s*[A-Za-z_][\w<>,\s[\]|]*\s*\{/.test(code) ||
    /\w<\w+(?:\s*,\s*\w+)*>\s*\(/.test(code)
  );
}

// ============================================================================
// Module syntax stripping
// ============================================================================

/**
 * Strip import/export statements from JavaScript code.
 * QuickJS doesn't support ES modules, so scripts access the SDK via
 * the global `bim` object built by the bridge.
 */
function stripModuleSyntax(code: string): string {
  let result = code;

  // Remove import statements: import ... from '...' or import '...'
  result = result.replace(/^\s*import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"][^'"]*['"];?\s*$/gm, '');

  // Remove export keywords (keep the declaration): export const/function/class → const/function/class
  result = result.replace(/^\s*export\s+(default\s+)?(const|let|var|function|class|async\s+function)\s/gm, '$2 ');

  // Remove bare "export default" expression statements
  result = result.replace(/^\s*export\s+default\s+/gm, '');

  // Remove export { ... } and export { ... } from '...'
  result = result.replace(/^\s*export\s+\{[^}]*\}(?:\s+from\s+['"][^'"]*['"])?\s*;?\s*$/gm, '');

  return result;
}

// ============================================================================
// Naive type stripping (fallback when esbuild-wasm unavailable)
// ============================================================================

/**
 * Regex-based type stripping — removes TypeScript-only syntax.
 * Not a full parser, but handles patterns commonly used in BIM scripts.
 */
export function naiveTypeStrip(code: string): string {
  let result = code;

  // Remove interface declarations (including multiline)
  result = result.replace(/^\s*(?:export\s+)?interface\s+\w+[^{]*\{[^}]*\}/gm, '');

  // Remove type alias declarations
  result = result.replace(/^\s*(?:export\s+)?type\s+\w+\s*=\s*[^;]+;/gm, '');

  // Strip variable type annotations using balanced-bracket scanner.
  // Handles: const x: [string, number][] = ..., const y: Array<{ a: T; b: U }> = ...
  result = stripVariableAnnotations(result);

  // Remove function parameter type annotations: (x: TYPE, y: TYPE)
  // Keep this scoped to parameter lists by requiring a leading "(" or ",".
  result = result.replace(/([,(]\s*)(\w+)\s*:\s*(?:string|number|boolean|void|any|unknown|never|null|undefined|Record<[^>]+>|Array<[^>]+>|Map<[^>]+>|Set<[^>]+>|\[[^\]]*\](?:\[\])?|[A-Za-z_]\w*(?:\[\])?(?:\s*\|\s*(?:string|number|boolean|null|undefined|[A-Za-z_]\w*))*)\s*(?=[,)])/g, '$1$2');

  // Remove function return type annotations: ): Type {
  result = result.replace(/\):\s*[^{]+\{/g, ') {');

  // Remove `as Type` casts — but not import aliases like `import { Foo as Bar }`
  result = result.replace(/(?<![{,]\s*\w+\s)\s+as\s+\w+(?:\[\])?/g, '');

  // Remove generic type parameters: <T>, <T extends U>
  result = result.replace(/<\w+(?:\s+extends\s+\w+)?>/g, '');

  return result;
}

/**
 * Strip type annotations from variable declarations using bracket-depth tracking.
 * Handles complex types like `Array<{ a: T; b: U }>` that contain semicolons
 * inside nested brackets — a simple regex `[^=;]*` would fail on these.
 */
function stripVariableAnnotations(code: string): string {
  const lines = code.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // Match: const/let/var NAME:
    const m = line.match(/^(\s*(?:const|let|var)\s+\w+)\s*:\s*/);
    if (!m) continue;

    const prefix = m[1];
    let i = m[0].length;
    let depth = 0;
    let found = false;

    // Scan through the type annotation, tracking bracket nesting
    while (i < line.length) {
      const ch = line[i];
      if (ch === '<' || ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '>' || ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === '=' && depth === 0) {
        // Found assignment at depth 0 — strip the type annotation
        lines[li] = prefix + ' ' + line.substring(i);
        found = true;
        break;
      }
      i++;
    }
    // If no '=' found, this is an uninitialized variable: `let x: Type`
    if (!found) {
      lines[li] = prefix;
    }
  }
  return lines.join('\n');
}
