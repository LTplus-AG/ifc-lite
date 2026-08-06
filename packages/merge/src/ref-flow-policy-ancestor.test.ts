/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two branches of the shared ref-merge flow that no test in `merge`, `cli`
 * or `collab-server` reached:
 *
 * 1. `checkRefPolicy` failing CLOSED on a candidate with NO provenance
 *    manifest. On the registry paths this is masked by defense in depth
 *    (the manual endpoint rejects manifest-less candidates on
 *    `requireHumanApproval` refs before calling `mergeIntoRef`, and
 *    `runAutoMerges` skips those refs), so it is reachable unmasked only
 *    through `ifc layer merge`.
 *
 * 2. `resolveAncestor`'s `base.kind === 'layer'` branch, which must include
 *    the named base layer ITSELF in the ancestor stack. `packages/mcp`
 *    emits a layer base when a draft is seeded from a specific published
 *    layer, so such candidates do reach the merge flow.
 */

import { describe, expect, it } from 'vitest';
import { computeLayerId, computeStackHash, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import { extractStackState } from './component-state.js';
import { checkRefPolicy, mergeIntoRef, resolveAncestor } from './ref-flow.js';
import type { LayerRefStore, RefEntry } from './ref-flow.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const SOUND = 'bsi::ifc::v5a::Pset_Acoustic::Rw';

class MemoryStore implements LayerRefStore {
  private layers = new Map<string, IfcxFile>();
  private refs = new Map<string, RefEntry>();
  storeLayer(file: IfcxFile): string {
    this.layers.set(file.header.id, structuredClone(file));
    return file.header.id;
  }
  loadLayer(id: string): IfcxFile {
    const f = this.layers.get(id);
    if (!f) throw new Error(`no layer ${id}`);
    return structuredClone(f);
  }
  getRef(name: string): RefEntry | undefined {
    const e = this.refs.get(name);
    return e ? structuredClone(e) : undefined;
  }
  setRef(name: string, entry: RefEntry): void {
    this.refs.set(name, structuredClone(entry));
  }
}

function bare(data: IfcxNode[]): IfcxFile {
  return {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 't',
      timestamp: '2026-08-04T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

function withId(file: IfcxFile): IfcxFile {
  return { ...file, header: { ...file.header, id: computeLayerId(file) } };
}

/** A publishable layer carrying a provenance manifest with an explicit base. */
function publishable(data: IfcxNode[], intent: string, base: ProvenanceBase | null): IfcxFile {
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base,
    created: '2026-08-04T00:00:00Z',
  });
  return withId(setProvenance(bare(data), manifest));
}

/** A layer with NO provenance manifest at all (`getProvenance` → undefined). */
function manifestLess(data: IfcxNode[]): IfcxFile {
  return withId(bare(data));
}

/** A publishable layer carrying a provenance manifest with an agent author. */
function agentAuthored(data: IfcxNode[], intent: string, base: ProvenanceBase | null): IfcxFile {
  const manifest = createProvenanceManifest({
    author: { kind: 'agent', principal: 'bot' },
    intent,
    base,
    created: '2026-08-04T00:00:00Z',
  });
  return withId(setProvenance(bare(data), manifest));
}

describe('checkRefPolicy fails closed on a manifest-less candidate', () => {
  /**
   * A candidate with no manifest could be an agent layer with the manifest
   * stripped, so `requireHumanApproval` must still bite. Treating "no
   * manifest" as "not agent-authored" would let any unapproved layer walk
   * straight onto a protected ref.
   */
  function protectedRef() {
    const store = new MemoryStore();
    const base = publishable(
      [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI30' } }],
      'Base',
      null,
    );
    store.storeLayer(base);
    store.setRef('protected', {
      layers: [base.header.id],
      policy: { requireHumanApproval: true },
    });
    // Touches a path the ref does not, so the three-way plan is
    // conflict-free and the flow reaches the policy gate.
    const candidate = manifestLess([
      { path: 'wall-2', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI90' } },
    ]);
    store.storeLayer(candidate);
    return { store, base, candidate };
  }

  it('refuses a manifest-less candidate on a requireHumanApproval ref', () => {
    const { store, base, candidate } = protectedRef();
    const outcome = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'protected' });
    expect(outcome.status).toBe('policy-failure');
    if (outcome.status !== 'policy-failure') return;
    expect(outcome.reason).toMatch(/human approval/i);
    // The ref must be untouched by the refused merge.
    expect(store.getRef('protected')?.layers).toEqual([base.header.id]);
  });

  it('admits the same manifest-less candidate once a human approves it', () => {
    const { store, candidate } = protectedRef();
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'protected',
      approvedBy: 'bob',
      principal: 'bob',
      created: '2026-08-04T01:00:00Z',
    });
    expect(outcome.status).toBe('merged');
  });

  it('still admits a manifest-less candidate on a ref with no approval requirement', () => {
    const { store, base, candidate } = protectedRef();
    store.setRef('open', { layers: [base.header.id] });
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'open',
      principal: 'bob',
      created: '2026-08-04T01:00:00Z',
    });
    expect(outcome.status).toBe('merged');
  });

  /**
   * `checkRefPolicy`'s gate is `manifest === undefined || manifest.author.kind
   * === 'agent'`. Every test above the manifest-less side only; this fixture
   * is the agent-with-manifest side, which had NO coverage anywhere in the
   * repo — a mutation swapping the literal to `'human'` (still fail-closed on
   * the manifest-less branch, so every other test here keeps passing) made
   * `pnpm test` fully green. That is exactly the shape the approval gate
   * exists to stop: an agent-authored, manifest-carrying candidate walking
   * onto a `requireHumanApproval` ref unattended.
   */
  it('refuses an agent-authored candidate WITH a manifest on a requireHumanApproval ref', () => {
    const store = new MemoryStore();
    const base = publishable(
      [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI30' } }],
      'Base',
      null,
    );
    store.storeLayer(base);
    store.setRef('protected', {
      layers: [base.header.id],
      policy: { requireHumanApproval: true },
    });
    const candidate = agentAuthored(
      [{ path: 'wall-2', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI90' } }],
      'Agent draft',
      null,
    );
    store.storeLayer(candidate);

    const refused = mergeIntoRef(store, { candidateId: candidate.header.id, into: 'protected' });
    expect(refused.status).toBe('policy-failure');
    if (refused.status !== 'policy-failure') return;
    expect(refused.reason).toMatch(/human approval/i);
    expect(store.getRef('protected')?.layers).toEqual([base.header.id]);

    // Control: the same candidate merges once a human approves it — proves
    // the gate is reachable and not permanently closed.
    const approved = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'protected',
      approvedBy: 'bob',
      principal: 'bob',
      created: '2026-08-04T01:00:00Z',
    });
    expect(approved.status).toBe('merged');
  });
});

describe('resolveAncestor: layer base includes the named layer itself', () => {
  /**
   * Ref stack is [L0, L1, L2]; the candidate declares `{ kind: 'layer', id: L1 }`.
   *
   * The correct ancestor is [L0, L1]. An ancestor one layer short ([L0])
   * still reports `matched: true`, so the unrelated-base refusal cannot
   * catch it — only the merge OUTCOME can. The fixture is built so the two
   * ancestors disagree: the candidate restates L1's FireRating verbatim.
   *
   *   - correct ancestor [L0, L1]: FIRE is REI60 in both ancestor and
   *     theirs → theirs did not change it → ours (REI90) wins cleanly.
   *   - short ancestor [L0]: FIRE is REI30 in the ancestor while theirs
   *     ([L0, candidate]) says REI60 and ours says REI90 → both sides
   *     changed it divergently → CONFLICT.
   */
  function layerBasedSetup() {
    const store = new MemoryStore();
    const l0 = publishable(
      [
        {
          path: 'wall-1',
          attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI30', [SOUND]: 40 },
        },
      ],
      'L0',
      null,
    );
    store.storeLayer(l0);
    const l1 = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI60' } }], 'L1', {
      kind: 'stack',
      id: computeStackHash([l0.header.id]),
    });
    store.storeLayer(l1);
    const l2 = publishable([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'L2', {
      kind: 'stack',
      id: computeStackHash([l0.header.id, l1.header.id]),
    });
    store.storeLayer(l2);
    store.setRef('main', { layers: [l0.header.id, l1.header.id, l2.header.id] });

    // Draft seeded from L1 (the shape `packages/mcp` emits): it rewrites
    // the fire pset unchanged and bumps the acoustic rating.
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI60', [SOUND]: 50 } }],
      'Draft off L1',
      { kind: 'layer', id: l1.header.id },
    );
    store.storeLayer(candidate);
    return { store, l0, l1, l2, candidate };
  }

  it('resolves a layer base to the prefix ENDING AT that layer', () => {
    const { store, l0, l1, l2 } = layerBasedSetup();
    const resolved = resolveAncestor(store, [l0.header.id, l1.header.id, l2.header.id], {
      kind: 'layer',
      id: l1.header.id,
    });
    expect(resolved.matched).toBe(true);
    expect(resolved.ids).toEqual([l0.header.id, l1.header.id]);
    expect(resolved.layers).toHaveLength(2);
  });

  it('merges without conflict — a one-layer-short ancestor would conflict', () => {
    const { store, candidate } = layerBasedSetup();
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      principal: 'bob',
      created: '2026-08-04T01:00:00Z',
    });
    // Under a short ancestor ([L0] instead of [L0, L1]) the candidate's
    // verbatim REI60 reads as a change away from REI30 and collides with
    // ours (REI90): the status would be 'conflicts', not 'merged'.
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;
    expect(outcome.ancestorMatched).toBe(true);
    expect(outcome.plan.conflicts).toEqual([]);

    const state = extractStackState(outcome.refLayers.map((id) => store.loadLayer(id)));
    const wall = state.get('wall-1');
    // Ours kept its later fire rating; the candidate's acoustic edit landed.
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI90');
    expect(wall?.components.get('pset:Pset_Acoustic')?.[SOUND]).toBe(50);
  });

  it('previews the same layer-based candidate as a conflict-free plan', () => {
    const { store, candidate } = layerBasedSetup();
    const outcome = mergeIntoRef(store, {
      candidateId: candidate.header.id,
      into: 'main',
      preview: true,
    });
    expect(outcome.status).toBe('preview');
    if (outcome.status !== 'preview') return;
    expect(outcome.ancestorMatched).toBe(true);
    expect(outcome.plan.conflicts).toEqual([]);
  });
});

describe('checkRefPolicy: requiredChecks enforcement', () => {
  const entry: RefEntry = { layers: [], policy: { requiredChecks: ['spec-a'] } };

  it('refuses when the required check has no passing evidence and is not waived', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'alice' },
      intent: 'x',
      base: null,
      checks: [],
    });
    const reason = checkRefPolicy(entry, manifest, [], undefined);
    expect(reason).toMatch(/spec-a/);
  });

  it('does not accept a passing check for a DIFFERENT spec as satisfying the required one', () => {
    // A predicate that ORs spec-match with pass-result (instead of ANDing
    // them) would let an unrelated passing check satisfy any required spec.
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'alice' },
      intent: 'x',
      base: null,
      checks: [{ tool: 't', spec: 'spec-b', result: 'pass' }],
    });
    const reason = checkRefPolicy(entry, manifest, [], undefined);
    expect(reason).toMatch(/spec-a/);
  });

  it('admits once the manifest carries a passing check for that exact spec', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'alice' },
      intent: 'x',
      base: null,
      checks: [{ tool: 't', spec: 'spec-a', result: 'pass' }],
    });
    expect(checkRefPolicy(entry, manifest, [], undefined)).toBeUndefined();
  });

  it('admits a missing/failing required check once it is explicitly waived', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'alice' },
      intent: 'x',
      base: null,
      checks: [],
    });
    const reason = checkRefPolicy(entry, manifest, [{ spec: 'spec-a', reason: 'known flaky' }], undefined);
    expect(reason).toBeUndefined();
  });

  it('still refuses an UNwaived required check when a different spec is waived', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'alice' },
      intent: 'x',
      base: null,
      checks: [],
    });
    const reason = checkRefPolicy(entry, manifest, [{ spec: 'spec-other', reason: 'unrelated' }], undefined);
    expect(reason).toMatch(/spec-a/);
  });
});
