/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pins the wire shapes `createDaluxApiMock` serves (#2493).
//
// The conformance run in `conformance.test.ts` reads these responses through
// `DaluxBuildProvider`, so a mock that quietly drifted into serving an
// idealised Dalux would turn that whole run green for the wrong reason. In
// particular `metadata.totalRemainingItems` — the field #2252 turned on —
// has to keep arriving in the shape it arrives in live.

import { describe, expect, it } from 'vitest';

import { DALUX_MOCK_BASE_URL, createDaluxApiMock, type DaluxMockWorld } from './dalux-api-mock.js';

const WORLD: DaluxMockWorld = {
  projects: [
    { projectId: 'p1', projectName: 'One', fileAreas: [] },
    { projectId: 'p2', projectName: 'Two', fileAreas: [] },
    { projectId: 'p3', projectName: 'Three', fileAreas: [] },
  ],
};

interface WirePage {
  readonly items: readonly unknown[];
  readonly metadata?: { readonly totalRemainingItems?: number };
  readonly links?: readonly { readonly rel: string; readonly href: string }[];
}

async function getProjects(fetchImpl: typeof fetch, bookmark?: string): Promise<WirePage> {
  const url = new URL(`${DALUX_MOCK_BASE_URL}/5.1/projects`);
  if (bookmark !== undefined) url.searchParams.set('bookmark', bookmark);
  const response = await fetchImpl(url.toString());
  return (await response.json()) as WirePage;
}

function nextBookmark(page: WirePage): string | undefined {
  const link = page.links?.find((candidate) => candidate.rel === 'nextPage');
  return link ? (new URL(link.href).searchParams.get('bookmark') ?? undefined) : undefined;
}

describe('createDaluxApiMock', () => {
  describe("remainingSemantics: 'total' — the shape observed live", () => {
    // `GET /5.1/projects` returned all 63 projects in one page, with no
    // `nextPage` link and `totalRemainingItems: 63`. Reading that counter as
    // "items still to come" is what made a complete listing look truncated
    // (#2252, fixed in #2253).
    it('reports a complete, link-less page as remaining === items.length', async () => {
      const page = await getProjects(createDaluxApiMock(WORLD, { pageSize: 100, remainingSemantics: 'total' }));

      expect(page.items).toHaveLength(3);
      expect(page.links).toBeUndefined();
      expect(page.metadata?.totalRemainingItems).toBe(3);
      expect(page.metadata?.totalRemainingItems).toBe(page.items.length);
    });

    it('keeps reporting the total, not the remainder, while paging', async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 2, remainingSemantics: 'total' });

      const first = await getProjects(fetchImpl);
      expect(first.items).toHaveLength(2);
      expect(first.metadata?.totalRemainingItems).toBe(3);

      const last = await getProjects(fetchImpl, nextBookmark(first));
      expect(last.items).toHaveLength(1);
      expect(last.links).toBeUndefined();
      expect(last.metadata?.totalRemainingItems).toBe(3);
    });
  });

  it("remainingSemantics: 'after-page' counts down to 0 on the last page", async () => {
    const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 2, remainingSemantics: 'after-page' });

    const first = await getProjects(fetchImpl);
    expect(first.metadata?.totalRemainingItems).toBe(1);

    const last = await getProjects(fetchImpl, nextBookmark(first));
    expect(last.metadata?.totalRemainingItems).toBe(0);
  });

  it("remainingSemantics: 'omitted' sends no metadata block at all", async () => {
    const page = await getProjects(createDaluxApiMock(WORLD, { pageSize: 100, remainingSemantics: 'omitted' }));
    expect(page.metadata).toBeUndefined();
  });

  it('mints a fresh bookmark per page and stops linking on the last one', async () => {
    const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 1, remainingSemantics: 'total' });

    const seen: string[] = [];
    let page = await getProjects(fetchImpl);
    let bookmark = nextBookmark(page);
    while (bookmark !== undefined) {
      expect(seen, `bookmark ${bookmark} was minted twice`).not.toContain(bookmark);
      seen.push(bookmark);
      page = await getProjects(fetchImpl, bookmark);
      bookmark = nextBookmark(page);
    }

    // 3 projects at 1 per page: two links, then a final page with none.
    expect(seen).toHaveLength(2);
    expect(page.items).toHaveLength(1);
  });

  it('ignores `limit`, exactly as the Dalux API does', async () => {
    const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 1, remainingSemantics: 'omitted' });
    const url = new URL(`${DALUX_MOCK_BASE_URL}/5.1/projects`);
    url.searchParams.set('limit', '100');

    const page = (await (await fetchImpl(url.toString())).json()) as WirePage;
    expect(page.items).toHaveLength(1);
  });

  it('404s an endpoint it does not model, rather than reading as an empty listing', async () => {
    const fetchImpl = createDaluxApiMock(WORLD);
    const response = await fetchImpl(`${DALUX_MOCK_BASE_URL}/9.9/projects/p1/nonsense`);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  describe('accepts every input shape `fetch` accepts', () => {
    // The mock is installed as `PluginContext.fetch`, so it has to honour the
    // whole `fetch` signature — not just the one spelling the current provider
    // happens to use. A `Request`'s `toString()` is `'[object Request]'`, which
    // `new URL()` rejects, so the mock used to fail the call with a parse error
    // instead of serving it: the next provider (or a `fetch` wrapper that
    // normalises to `Request`) would have hit that, not a conformance failure.
    it('serves a string URL', async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 100 });
      const page = (await (await fetchImpl(`${DALUX_MOCK_BASE_URL}/5.1/projects`)).json()) as WirePage;
      expect(page.items).toHaveLength(3);
    });

    it('serves a URL object', async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 100 });
      const page = (await (await fetchImpl(new URL(`${DALUX_MOCK_BASE_URL}/5.1/projects`))).json()) as WirePage;
      expect(page.items).toHaveLength(3);
    });

    it('serves a Request', async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 100 });
      const page = (await (
        await fetchImpl(new Request(`${DALUX_MOCK_BASE_URL}/5.1/projects`))
      ).json()) as WirePage;
      expect(page.items).toHaveLength(3);
    });

    it("honours a Request's own signal, which is the only one an init-less call carries", async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 100 });
      const controller = new AbortController();
      controller.abort();
      const request = new Request(`${DALUX_MOCK_BASE_URL}/5.1/projects`, { signal: controller.signal });

      await expect(fetchImpl(request)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('still honours an init signal', async () => {
      const fetchImpl = createDaluxApiMock(WORLD, { pageSize: 100 });
      const controller = new AbortController();
      controller.abort();

      await expect(
        fetchImpl(`${DALUX_MOCK_BASE_URL}/5.1/projects`, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('rejects a pageSize that cannot describe a page', () => {
    // `pageSize: 0` slices an empty page whose bookmark equals the one it was
    // handed, and then advertises a `nextPage` link back to itself — the caller
    // spins or trips its own repeated-bookmark guard, and the failure surfaces
    // nowhere near the test that configured it. Fail at construction instead.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`throws for pageSize ${String(bad)}`, () => {
        expect(() => createDaluxApiMock(WORLD, { pageSize: bad })).toThrow(TypeError);
        expect(() => createDaluxApiMock(WORLD, { pageSize: bad })).toThrow(/positive integer/);
      });
    }

    it('anti-mutation: a usable pageSize still builds, and the default still pages', async () => {
      expect(() => createDaluxApiMock(WORLD, { pageSize: 1 })).not.toThrow();
      expect(() => createDaluxApiMock(WORLD, { pageSize: 100 })).not.toThrow();
      // Default is 1 — every multi-item listing must still cross a boundary.
      const page = await getProjects(createDaluxApiMock(WORLD));
      expect(page.items).toHaveLength(1);
      expect(nextBookmark(page)).toBeDefined();
    });
  });
});
