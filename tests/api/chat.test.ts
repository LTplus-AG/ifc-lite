/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatHandler,
  loadChatConfig,
  type ChatConfig,
  type ChatUsageStore,
  type UsageReservationResult,
  type UsageSnapshot,
} from '../../server/chat/chat-handler.js';

function createConfig(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    apiBase: 'https://provider.example',
    apiKey: 'test-key',
    appUrl: 'https://app.example',
    allowedOrigins: [],
    freeModels: new Set(['openai/gpt-free']),
    freeDailyLimit: 3,
    debugCredits: false,
    ...overrides,
  };
}

function createSseResponse(chunk: string = 'ok'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

class MemoryUsageStore implements ChatUsageStore {
  readonly snapshots = new Map<string, { free: number }>();
  lastUserIds: string[] = [];

  private ensure(userId: string) {
    this.lastUserIds.push(userId);
    let entry = this.snapshots.get(userId);
    if (!entry) {
      entry = { free: 0 };
      this.snapshots.set(userId, entry);
    }
    return entry;
  }

  async getUsageSnapshot(userId: string): Promise<UsageSnapshot> {
    const entry = this.ensure(userId);
    return { type: 'requests', used: entry.free, limit: 3, pct: entry.free * 33, resetAt: 1_700_000_000 };
  }

  async consumeFreeRequest(userId: string): Promise<UsageReservationResult> {
    const entry = this.ensure(userId);
    if (entry.free >= 3) {
      return { allowed: false, snapshot: await this.getUsageSnapshot(userId) };
    }
    entry.free += 1;
    return { allowed: true, snapshot: await this.getUsageSnapshot(userId) };
  }
}

class SingleReadUsageStore implements ChatUsageStore {
  snapshotReads = 0;

  async getUsageSnapshot(): Promise<UsageSnapshot> {
    this.snapshotReads += 1;
    if (this.snapshotReads > 1) {
      throw new Error('unexpected post-stream usage lookup');
    }
    return { type: 'requests', used: 0, limit: 3, pct: 0, resetAt: 1_700_000_000 };
  }

  async consumeFreeRequest(): Promise<UsageReservationResult> {
    return {
      allowed: true,
      snapshot: { type: 'requests', used: 1, limit: 3, pct: 33, resetAt: 1_700_000_000 },
    };
  }
}

class HangingUsageStore implements ChatUsageStore {
  async getUsageSnapshot(): Promise<UsageSnapshot> {
    return await new Promise<UsageSnapshot>(() => {});
  }

  async consumeFreeRequest(): Promise<UsageReservationResult> {
    return await new Promise<UsageReservationResult>(() => {});
  }
}

test('chat handler rejects disallowed origins before provider work begins', async () => {
  const usageStore = new MemoryUsageStore();
  let fetchCalls = 0;
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('nope', { status: 500 });
    },
    usageStore,
    now: () => Date.now(),
  });

  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'text/plain',
    },
    body: JSON.stringify({ model: 'openai/gpt-free', messages: [{ role: 'user', content: 'hi' }] }),
  }));

  assert.equal(response.status, 403);
  assert.equal(fetchCalls, 0);
  assert.equal(usageStore.lastUserIds.length, 0);
});

test('anonymous usage is isolated per forwarded IP fingerprint', async () => {
  const usageStore = new MemoryUsageStore();
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => createSseResponse(),
    usageStore,
    now: () => Date.now(),
  });

  await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
    },
    body: JSON.stringify({ model: 'openai/gpt-free', messages: [{ role: 'user', content: 'one' }] }),
  }));
  await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.2',
    },
    body: JSON.stringify({ model: 'openai/gpt-free', messages: [{ role: 'user', content: 'two' }] }),
  }));

  const anonIds = [...new Set(usageStore.lastUserIds.filter((id) => id.startsWith('anon:')))];
  assert.equal(anonIds.length, 2);
  assert.notEqual(anonIds[0], anonIds[1]);
});

test('chat handler accepts preview-style relative request URLs for usage snapshots', async () => {
  const usageStore = new MemoryUsageStore();
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => new Response('unused', { status: 500 }),
    usageStore,
    now: () => Date.now(),
  });

  const request = {
    method: 'GET',
    url: '/api/chat?usage=1',
    headers: new Headers({
      host: 'preview.example',
      'x-forwarded-proto': 'https',
      origin: 'https://app.example',
      'x-forwarded-for': '203.0.113.10',
    }),
  } as unknown as Request;

  const response = await handler(request);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Usage-Limit'), '3');
});

test('chat handler accepts same-origin preview requests even when APP_URL points at production', async () => {
  const usageStore = new MemoryUsageStore();
  const handler = createChatHandler(createConfig({
    appUrl: 'https://ifc-lite.com',
    allowedOrigins: [],
  }), {
    fetchImpl: async () => new Response('unused', { status: 500 }),
    usageStore,
    now: () => Date.now(),
  });

  const response = await handler({
    method: 'GET',
    url: '/api/chat?usage=1',
    headers: {
      host: 'ifc-lite-preview.vercel.app',
      origin: 'https://ifc-lite-preview.vercel.app',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.10',
    },
  } as unknown as Request);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://ifc-lite-preview.vercel.app');
});

test('chat handler accepts Vercel-style plain-object headers and body for POST requests', async () => {
  const usageStore = new MemoryUsageStore();
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => createSseResponse(),
    usageStore,
    now: () => Date.now(),
  });

  const request = {
    method: 'POST',
    url: '/api/chat',
    headers: {
      host: 'preview.example',
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.10',
    },
    body: { model: 'openai/gpt-free', messages: [{ role: 'user', content: 'hi' }] },
  } as unknown as Request;

  const response = await handler(request);

  assert.equal(response.status, 200);
});

test('chat handler completes streaming without a post-stream usage lookup', async () => {
  const usageStore = new SingleReadUsageStore();
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => createSseResponse('streamed'),
    usageStore,
    now: () => Date.now(),
  });

  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ model: 'openai/gpt-free', messages: [{ role: 'user', content: 'hi' }] }),
  }));

  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(usageStore.snapshotReads, 1);
  assert.match(body, /streamed/);
  assert.match(body, /__ifcLiteUsage/);
});

test('chat handler returns a timeout when usage snapshot loading hangs', async () => {
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => createSseResponse(),
    usageStore: new HangingUsageStore(),
    now: () => Date.now(),
  });

  const response = await handler({
    method: 'GET',
    url: '/api/chat?usage=1',
    headers: { host: 'preview.example', origin: 'https://app.example' },
  } as unknown as Request);

  const body = await response.json() as { code?: string };
  assert.equal(response.status, 504);
  assert.equal(body.code, 'usage_store_timeout');
});

test('chat handler returns a timeout when the provider never responds', async () => {
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => await new Promise<Response>(() => {}),
    usageStore: new MemoryUsageStore(),
    now: () => Date.now(),
  });

  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ model: 'openai/gpt-free', messages: [{ role: 'user', content: 'hi' }] }),
  }));

  const body = await response.json() as { code?: string };
  assert.equal(response.status, 504);
  assert.equal(body.code, 'provider_timeout');
});

test('loadChatConfig loads basic config from environment', () => {
  const config = loadChatConfig({
    LLM_API_BASE: 'https://provider.example',
    LLM_API_KEY: 'key',
    LLM_FREE_MODELS: 'openai/gpt-free',
    LLM_FREE_DAILY_LIMIT: '3',
    APP_URL: 'https://app.example',
  });

  assert.deepEqual([...config.freeModels], ['openai/gpt-free']);
  assert.equal(config.freeDailyLimit, 3);
});

test('chat handler rejects non-free models with 400', async () => {
  const usageStore = new MemoryUsageStore();
  const handler = createChatHandler(createConfig(), {
    fetchImpl: async () => createSseResponse(),
    usageStore,
    now: () => Date.now(),
  });

  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: {
      origin: 'https://app.example',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify({ model: 'openai/gpt-pro', messages: [{ role: 'user', content: 'hi' }] }),
  }));

  assert.equal(response.status, 400);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'model_not_allowed');
});
