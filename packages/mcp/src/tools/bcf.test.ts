/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bcf_topic_list status filter.
 *
 * BCF status strings are conventionally Title Case ('Open', 'Closed'), but
 * nothing in the tool's schema or description tells an agent that, and an
 * agent has no independent way to check a topic's exact casing before
 * filtering. An exact `===` match silently returned an empty list for a
 * differently-cased filter — identical, from the caller's side, to "there
 * really are no matching topics" (the error-vs-empty distinction this
 * audit was told is "the whole ballgame"). `@ifc-lite/bcf`'s
 * `computeMarkers3D` already lowercases both sides for its own status
 * filter, so this is also a same-repo behavioural inconsistency.
 */

import { describe, it, expect } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { bcfTools } from './bcf.js';
import type { CallToolResult } from '../protocol/index.js';

function tool(name: string) {
  const found = bcfTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

function makeCtx(): ToolContext {
  return {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG },
  };
}

interface ListShape {
  count: number;
  topics: Array<{ guid: string; status?: string }>;
}

describe('bcf_topic_list status filter', () => {
  it('matches a status filter case-insensitively', async () => {
    const ctx = makeCtx();
    // Default status is 'Open' (Title Case) — see bcf_topic_create's schema default.
    const created = (await tool('bcf_topic_create').handler({ title: 'Clash on Level 2' }, ctx)) as CallToolResult;
    expect(created.structuredContent).toBeDefined();

    const lower = (await tool('bcf_topic_list').handler({ status: 'open' }, ctx)) as CallToolResult;
    const lowerResult = lower.structuredContent as unknown as ListShape;
    expect(lowerResult.count).toBe(1);
    expect(lowerResult.topics).toHaveLength(1);

    const exact = (await tool('bcf_topic_list').handler({ status: 'Open' }, ctx)) as CallToolResult;
    const exactResult = exact.structuredContent as unknown as ListShape;
    expect(exactResult.count).toBe(1);
  });

  it('control: an unrelated status still returns nothing', async () => {
    const ctx = makeCtx();
    await tool('bcf_topic_create').handler({ title: 'Clash on Level 2' }, ctx);

    const result = (await tool('bcf_topic_list').handler({ status: 'closed' }, ctx)) as CallToolResult;
    const shape = result.structuredContent as unknown as ListShape;
    expect(shape.count).toBe(0);
    expect(shape.topics).toHaveLength(0);
  });
});
