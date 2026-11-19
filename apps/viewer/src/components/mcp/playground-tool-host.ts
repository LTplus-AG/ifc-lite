/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `/mcp/playground` page as an agent tool host (#9523).
 *
 * The playground parses its own copy of a file into a `HeadlessLikeBackend`,
 * so a model's pending edits are that backend's overlay. It is a single-model
 * session: `model_list` names the model the call was made on, as it always has.
 */

import { BsddNamespace } from '@ifc-lite/sdk';
import type { AgentTool, ReadyModel, ToolHost } from '@/lib/agent-tools/types';
import type { LoadedPlaygroundModel } from './playground-dispatcher.js';

/**
 * Browser-safe bSDD client routed through this site's `/api/bsdd/*` proxy.
 * The default BsddNamespace hits `api.bsdd.buildingsmart.org` directly,
 * which fails CORS in browsers. Vite (dev) and Vercel (prod) both rewrite
 * `/api/bsdd/*` to that host already, so we share the SDK's namespace
 * implementation but swap the base URL.
 */
const PROXIED_BSDD = new BsddNamespace({ apiBase: '/api/bsdd' });

export function playgroundModelHandle(model: LoadedPlaygroundModel): ReadyModel {
  return {
    id: model.id,
    name: model.name,
    fileSize: model.fileSize,
    status: 'ready',
    store: model.store,
    bim: model.bim,
    mutationView: () => model.backend.getMutationView(),
  };
}

export function playgroundToolHost(model: LoadedPlaygroundModel): ToolHost {
  return { models: () => [playgroundModelHandle(model)], bsdd: PROXIED_BSDD };
}

/** Run a shared tool against the model a playground call was made on. */
export function runOnPlaygroundModel(
  tool: AgentTool,
  model: LoadedPlaygroundModel,
  args: Record<string, unknown>,
  ctx: { signal?: AbortSignal },
) {
  const host = playgroundToolHost(model);
  return tool.needs === 'none'
    ? tool.run(host, args, ctx)
    : tool.run(host, playgroundModelHandle(model), args, ctx);
}
