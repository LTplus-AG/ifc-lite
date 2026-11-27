/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer catalog: the IFC catalog's ids, schemas and instructions from
 * `@ifc-lite/a2ui`, paired with this viewer's React components and with
 * function implementations bound to one host. `createIfcCatalog` checks the
 * names match, so the renderer and the agent prompt cannot drift.
 */

import { MessageProcessor, type ActionListener, type FunctionImplementation } from '@a2ui/web_core/v1_0';
import type { ReactCatalogComponent } from '@a2ui/react';
import { isIfcFunction } from '@ifc-lite/a2ui';
import { basicFunctionImplementation, createIfcCatalog, IFC_CATALOG_FUNCTION_APIS } from '@ifc-lite/a2ui/catalog';
import { IFC_REACT_COMPONENTS } from '@/components/a2ui/implementations';
import type { A2uiViewerHost } from './host.js';
import { runIfcFunction } from './functions.js';

/** IFC functions bound to `host`; basic ones come from the shared lookup (v1.0 validation first). */
export function ifcFunctionImplementations(host: A2uiViewerHost): FunctionImplementation[] {
  return IFC_CATALOG_FUNCTION_APIS.map((api) => {
    if (isIfcFunction(api.name)) {
      const name = api.name;
      return {
        ...api,
        execute: (args, ctx) => runIfcFunction(host, name, args, {
          caller: 'renderer',
          userActivated: ctx.isUserActivated && !ctx.isPassiveEvaluation,
        }),
      } satisfies FunctionImplementation;
    }
    const basic = basicFunctionImplementation(api.name);
    if (!basic) throw new Error(`No implementation for basic function ${api.name}`);
    return basic;
  });
}

function createRendererCatalog(host: A2uiViewerHost) {
  return createIfcCatalog<ReactCatalogComponent, FunctionImplementation>({
    components: IFC_REACT_COMPONENTS,
    functions: ifcFunctionImplementations(host),
  });
}

/** One processor holds the surfaces of one chat message (or one script output). */
export function createRendererProcessor(host: A2uiViewerHost, onAction: ActionListener): MessageProcessor<ReactCatalogComponent> {
  return new MessageProcessor<ReactCatalogComponent>([createRendererCatalog(host)], onAction);
}
