/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Agent-side helpers over `@a2ui/agent`: the prompt snippet that teaches a
 * model the IFC catalog, and parsing of its replies into validated A2UI
 * messages, whole or streamed.
 *
 * Browser note: `@a2ui/agent` imports `fs` and `path` at module top for its
 * file-system catalog provider, which this module never calls. Browser
 * bundles alias both to a throwing stub (see the viewer's `vite-a2ui-node-builtins.ts`).
 */

import {
  A2uiGenerator,
  CatalogConfig,
  ExpressFormatFactory,
  RendererState,
  validatePayload,
  type A2uiRequestProcessor,
  type AgentToRendererMessage,
  type ResponsePart,
  type ResponseStream,
  type StreamPart,
} from '@a2ui/agent';
import type { MessageProcessor } from '@a2ui/web_core/v1_0';
import { A2UI_PROTOCOL_VERSION, IFC_CATALOG_ID } from './policy.js';
import { createIfcCatalog } from './catalog/catalog.js';

export interface IfcStreamOptions {
  /**
   * The renderer's processor when the same app renders the answer (a browser
   * chat). Messages are then validated against, and applied to, that processor.
   */
  renderer?: MessageProcessor;
}

export interface IfcAgent {
  /** Append to the system prompt. */
  readonly promptSnippet: string;
  /** Parse a complete reply. Throws `A2uiError` with `partialResults` on a bad block. */
  parse(reply: string): ResponsePart[];
  /** Stream a reply chunk by chunk. A rejected block yields an `error` part and parsing continues. */
  openStream(options?: IfcStreamOptions): ResponseStream<StreamPart>;
}

let generator: A2uiGenerator | undefined;

/** Express format: about a third of the tokens of direct JSON. */
export function createIfcAgent(): IfcAgent {
  generator ??= new A2uiGenerator([new CatalogConfig(createIfcCatalog())], undefined, new ExpressFormatFactory());
  const processor: A2uiRequestProcessor = generator.createProcessor({
    [A2UI_PROTOCOL_VERSION]: { supportedCatalogIds: [IFC_CATALOG_ID] },
  });
  return {
    promptSnippet: processor.promptSnippet,
    parse: (reply) => processor.parseResponse(reply),
    openStream: (streamOptions = {}) =>
      processor.openStream({
        afterRejectedBlock: 'continue',
        ...(streamOptions.renderer ? { state: RendererState.of(streamOptions.renderer) } : {}),
      }),
  };
}

/** Validate messages produced elsewhere (scripts, MCP tools). Returns problems, empty when valid. */
const validationCatalog = { current: undefined as ReturnType<typeof createIfcCatalog> | undefined };

export function validateIfcMessages(messages: unknown): string[] {
  validationCatalog.current ??= createIfcCatalog();
  try {
    validatePayload([validationCatalog.current], messages);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export type { AgentToRendererMessage, ResponsePart, StreamPart, ResponseStream };
