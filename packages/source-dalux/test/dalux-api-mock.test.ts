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
});
