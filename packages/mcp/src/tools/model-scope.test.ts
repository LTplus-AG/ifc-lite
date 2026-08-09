/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-model access control, end to end.
 *
 * `AuthScope.modelIds` narrows a token to a subset of the loaded models. The
 * server enforces it at three places — `resolveModel`/`assertModelAccess` (the
 * choke point every tool goes through), `model_list` (so an out-of-scope id is
 * not leaked by enumeration) and `model_unload` (so a narrowed token cannot
 * evict someone else's session). None of them had a test: every fixture in the
 * package used `fullScope()`/`readOnlyScope()`, which leave `modelIds`
 * undefined, so `modelAllowed` could be replaced by `return true` and the whole
 * suite stayed green.
 *
 * A token narrowed to one model would then read, mutate and unload every other
 * model in the process.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthScope } from '../auth/scope.js';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { loadIfcModel } from '../loader.js';
import { discoveryTools } from './discovery.js';
import { queryTools } from './query.js';
import { assertModelAccess, resolveModel } from './util.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

function minimalModel(projectGuid: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${projectGuid}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#72= IFCWALL('${guid('WALL')}',$,'Wall',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;
}

const ALL_TOOLS = [...discoveryTools, ...queryTools];

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

/** Invoke a tool. Handlers may throw synchronously or reject; normalise to a
 *  rejection so `.rejects` works for both. */
async function call(name: string, input: Record<string, unknown>) {
  return tool(name).handler(input, ctx);
}

let tmp: string;
let ctx: ToolContext;

/** Two models loaded; the caller's scope is narrowed to `alpha` only. */
async function sessionWithScope(scope: AuthScope): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope,
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'alpha.ifc'), { modelId: 'alpha' }));
  ctx.registry.add(await loadIfcModel(join(tmp, 'beta.ifc'), { modelId: 'beta' }));
}

const NARROWED: AuthScope = { scopes: ['read', 'validate', 'export', 'admin'], modelIds: ['alpha'] };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-model-scope-'));
  await writeFile(join(tmp, 'alpha.ifc'), minimalModel(guid('ALPH')), 'utf-8');
  await writeFile(join(tmp, 'beta.ifc'), minimalModel(guid('BETA')), 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('a token narrowed to one model', () => {
  beforeEach(async () => {
    await sessionWithScope(NARROWED);
  });

  it('reaches the model it is allowed to', () => {
    expect(resolveModel(ctx, 'alpha').id).toBe('alpha');
    // Sanity: `beta` is genuinely loaded, so the denial below is about scope
    // and not about a missing model.
    expect(ctx.registry.get('beta')?.id).toBe('beta');
    expect(ctx.registry.count()).toBe(2);
  });

  it('is denied the model it is not allowed to, with PERMISSION_DENIED not MODEL_NOT_FOUND', () => {
    // The distinction matters: MODEL_NOT_FOUND would tell the agent to load it,
    // and would also confirm the id does not exist — which is untrue.
    try {
      resolveModel(ctx, 'beta');
      expect.unreachable('resolveModel should have thrown for an out-of-scope model');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
      expect((err as ToolExecutionError).code).toBe(ToolErrorCode.PERMISSION_DENIED);
    }
  });

  it('does not leak out-of-scope ids in the MODEL_NOT_FOUND `available` list', () => {
    try {
      resolveModel(ctx, 'does-not-exist');
      expect.unreachable('resolveModel should have thrown for an unknown model');
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe(ToolErrorCode.MODEL_NOT_FOUND);
      expect((e.details as { available: string[] }).available).toEqual(['alpha']);
    }
  });

  it('is denied by assertModelAccess directly, admin scope notwithstanding', () => {
    const beta = ctx.registry.get('beta');
    expect(beta).not.toBeNull();
    expect(() => assertModelAccess(ctx, beta!)).toThrow(/not permitted for this token/);
    expect(assertModelAccess(ctx, ctx.registry.get('alpha')!).id).toBe('alpha');
  });

  it('sees only the permitted model from model_list', async () => {
    const res = await call('model_list', {});
    const out = res.structuredContent as { count: number; models: Array<{ id: string }> };
    expect(out.models.map((m) => m.id)).toEqual(['alpha']);
    // The count has to agree with the filtered list, not with the registry —
    // "2 models loaded" next to one row is the leak in a friendlier costume.
    expect(out.count).toBe(1);
  });

  it('cannot unload a model outside its allowlist', async () => {
    await expect(call('model_unload', { model_id: 'beta' }))
      .rejects.toThrow(/not permitted for this token/);
    expect(ctx.registry.get('beta')).not.toBeNull();

    // Counter-example: the permitted model unloads fine, so the rejection above
    // is about the allowlist and not about `model_unload` being broken.
    await call('model_unload', { model_id: 'alpha' });
    expect(ctx.registry.get('alpha')).toBeNull();
  });

  it('cannot read entities out of an out-of-scope model', async () => {
    await expect(call('query_entities', { model_id: 'beta', type: 'IfcWall' }))
      .rejects.toThrow(/not permitted for this token/);
    const ok = await call('query_entities', { model_id: 'alpha', type: 'IfcWall' });
    expect((ok.structuredContent as { count: number }).count).toBe(1);
  });
});

describe('a token with no allowlist', () => {
  it('reaches every loaded model', async () => {
    await sessionWithScope({ scopes: ['read', 'admin'] });
    expect(resolveModel(ctx, 'alpha').id).toBe('alpha');
    expect(resolveModel(ctx, 'beta').id).toBe('beta');
    const res = await call('model_list', {});
    const out = res.structuredContent as { count: number; models: Array<{ id: string }> };
    expect(out.models.map((m) => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(out.count).toBe(2);
  });
});

describe('resolveModel without an explicit model_id', () => {
  it('demands a model_id as soon as a second model is loaded', async () => {
    await sessionWithScope({ scopes: ['read'] });
    expect(ctx.registry.count()).toBe(2);
    try {
      resolveModel(ctx);
      expect.unreachable('resolveModel should have demanded a model_id');
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe(ToolErrorCode.MODEL_REQUIRED);
      expect((e.details as { available: string[] }).available.sort()).toEqual(['alpha', 'beta']);
    }
  });

  it('picks the only model when exactly one is loaded', async () => {
    await sessionWithScope({ scopes: ['read'] });
    ctx.registry.remove('beta');
    expect(ctx.registry.count()).toBe(1);
    expect(resolveModel(ctx).id).toBe('alpha');
  });

  it('reports MODEL_NOT_FOUND when nothing is loaded', async () => {
    await sessionWithScope({ scopes: ['read'] });
    ctx.registry.remove('alpha');
    ctx.registry.remove('beta');
    try {
      resolveModel(ctx);
      expect.unreachable('resolveModel should have thrown with an empty registry');
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe(ToolErrorCode.MODEL_NOT_FOUND);
    }
  });
});
