/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash grouping (Phase 2) — collapse a flat `ClashResult` into `ClashGroup`s,
 * the unit of a single BCF topic.
 *
 * Everything here is pure and deterministic: ids and ordering are derived only
 * from the input clashes (FNV-1a over sorted member ids), never from the clock
 * or any randomness. The BCF bridge owns any capping; this module never drops.
 */

import type { AABB } from '@ifc-lite/spatial';
import { center } from './math/aabb.js';
import { distSq } from './math/vec3.js';
import { CLASH_RULE_PRESETS, DISCIPLINES } from './disciplines.js';
import { qualifiedKey } from './exclude.js';
import type {
  Clash,
  ClashElementRef,
  ClashGroup,
  ClashResult,
  ClashSeverity,
  Vec3,
} from './types.js';

/** How to partition a `ClashResult` into groups. */
export interface GroupOptions {
  by: 'cluster' | 'rule' | 'typePair' | 'element' | 'storey';
  /** Cluster radius in metres for `by: 'cluster'`. Defaults to 1.5 m. */
  epsilon?: number;
}

const DEFAULT_EPSILON = 1.5;

const SEVERITY_RANK: Record<ClashSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/** Stable 32-bit FNV-1a hash of a string, hex-encoded. Purely input-derived. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // Fold both bytes of each UTF-16 code unit so non-ASCII ids cannot collide.
    // 32-bit FNV prime multiply via shifts to stay in unsigned range.
    hash ^= code & 0xff;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Union of two axis-aligned boxes. */
function unionBounds(a: AABB, b: AABB): AABB {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

/** Union of all member bounds. `members` is assumed non-empty. */
function unionOfBounds(members: Clash[]): AABB {
  let acc = members[0].bounds;
  for (let i = 1; i < members.length; i += 1) {
    acc = unionBounds(acc, members[i].bounds);
  }
  return acc;
}

/** Mean of member points. `members` is assumed non-empty. */
function meanPoint(members: Clash[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const m of members) {
    x += m.point[0];
    y += m.point[1];
    z += m.point[2];
  }
  const n = members.length;
  return [x / n, y / n, z / n];
}

/** Most severe severity among members (critical wins). Assumes non-empty. */
function maxSeverity(members: Clash[]): ClashSeverity {
  let best: ClashSeverity = members[0].severity;
  for (let i = 1; i < members.length; i += 1) {
    if (SEVERITY_RANK[members[i].severity] < SEVERITY_RANK[best]) {
      best = members[i].severity;
    }
  }
  return best;
}

/** Sorted, separator-joined member ids — the basis for the stable group id. */
function memberIdSignature(members: Clash[]): string {
  const ids = members.map((m) => m.id).sort();
  // Newline separates ids: it cannot occur inside an engine clash id (a single
  // line of space-separated GUID/path tokens), so the join stays injective even
  // if a model name or key contains spaces.
  return ids.join('\n');
}

/**
 * Stable group id. `discriminator` distinguishes groups that share a member set
 * but mean different things — notably element-mode groups, where two elements
 * that clash only with each other would otherwise collide on an identical id
 * (and downstream produce duplicate BCF topic GUIDs).
 */
function groupId(members: Clash[], discriminator = ''): string {
  return `grp-${fnv1a(`${discriminator}\n${memberIdSignature(members)}`)}`;
}

/** Sorted type-pair key, order-independent: `IfcBeam|IfcPipeSegment`. */
function typePairKey(clash: Clash): string {
  const [first, second] =
    clash.a.tag <= clash.b.tag ? [clash.a.tag, clash.b.tag] : [clash.b.tag, clash.a.tag];
  return `${first}|${second}`;
}

/** Discipline label for a rule, via presets then the discipline table. */
function disciplineForRule(rule: string): string | undefined {
  const preset = CLASH_RULE_PRESETS.find((p) => p.id === rule);
  if (preset) {
    return preset.name;
  }
  const upper = rule.toUpperCase();
  for (const info of Object.values(DISCIPLINES)) {
    if (upper === info.code) {
      return info.label;
    }
  }
  return undefined;
}

/** Human-readable title for a rule-based group. */
function ruleTitle(rule: string): string {
  const label = disciplineForRule(rule);
  return label ? `${label} (${rule})` : `Rule ${rule}`;
}

function makeGroup(
  members: Clash[],
  title: string,
  discipline: string | undefined,
  discriminator = '',
): ClashGroup {
  const group: ClashGroup = {
    id: groupId(members, discriminator),
    title,
    members,
    bounds: unionOfBounds(members),
    representativePoint: meanPoint(members),
    severity: maxSeverity(members),
  };
  if (discipline !== undefined) {
    group.discipline = discipline;
  }
  return group;
}

/** Union-find over `0..n-1`. Roots are always the lowest index in the set, so
 *  the partition it produces does not depend on the order of the unions. */
function createUnionFind(n: number): { find: (i: number) => number; union: (i: number, j: number) => void } {
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    parent[i] = i;
  }
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root];
    }
    // Path compression keeps repeated lookups flat; deterministic.
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) {
      // Attach the higher-index root under the lower to keep ids stable.
      if (ri < rj) {
        parent[rj] = ri;
      } else {
        parent[ri] = rj;
      }
    }
  };
  return { find, union };
}

/**
 * Spatial DBSCAN-style clustering: two clashes join iff they share the same
 * `rule` AND the same sorted type-pair AND their `point`s are within `epsilon`
 * (transitively). Partitioning by (rule, type-pair) first keeps unrelated
 * conflicts apart even when co-located. O(n^2) within each partition.
 */
function clusterGroups(clashes: Clash[], epsilon: number): ClashGroup[] {
  const partitions = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const key = `${clash.rule}\n${typePairKey(clash)}`;
    const bucket = partitions.get(key);
    if (bucket) {
      bucket.push(clash);
    } else {
      partitions.set(key, [clash]);
    }
  }

  const epsilonSq = epsilon * epsilon;
  const groups: ClashGroup[] = [];

  for (const bucket of partitions.values()) {
    const n = bucket.length;
    const { find, union } = createUnionFind(n);

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (distSq(bucket[i].point, bucket[j].point) <= epsilonSq) {
          union(i, j);
        }
      }
    }

    const byRoot = new Map<number, Clash[]>();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      const members = byRoot.get(root);
      if (members) {
        members.push(bucket[i]);
      } else {
        byRoot.set(root, [bucket[i]]);
      }
    }

    for (const members of byRoot.values()) {
      const sample = members[0];
      const discipline = disciplineForRule(sample.rule);
      const title = `${typePairKey(sample).replaceAll('|', ' vs ')} (${sample.rule})`;
      groups.push(makeGroup(members, title, discipline));
    }
  }

  return groups;
}

function ruleGroups(clashes: Clash[]): ClashGroup[] {
  const byRule = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const bucket = byRule.get(clash.rule);
    if (bucket) {
      bucket.push(clash);
    } else {
      byRule.set(clash.rule, [clash]);
    }
  }
  const groups: ClashGroup[] = [];
  for (const [rule, members] of byRule) {
    groups.push(makeGroup(members, ruleTitle(rule), disciplineForRule(rule)));
  }
  return groups;
}

function typePairGroups(clashes: Clash[]): ClashGroup[] {
  const byPair = new Map<string, Clash[]>();
  for (const clash of clashes) {
    const key = typePairKey(clash);
    const bucket = byPair.get(key);
    if (bucket) {
      bucket.push(clash);
    } else {
      byPair.set(key, [clash]);
    }
  }
  const groups: ClashGroup[] = [];
  for (const [key, members] of byPair) {
    groups.push(makeGroup(members, key.replaceAll('|', ' vs '), undefined));
  }
  return groups;
}

function elementGroups(clashes: Clash[]): ClashGroup[] {
  // Each clash contributes to BOTH participating elements, keyed by (model, key)
  // so federated elements that share a key do not collide into one group.
  const byElement = new Map<string, { ref: ClashElementRef; members: Clash[] }>();
  for (const clash of clashes) {
    for (const ref of [clash.a, clash.b]) {
      const k = qualifiedKey(ref.model, ref.key);
      const bucket = byElement.get(k);
      if (bucket) {
        bucket.members.push(clash);
      } else {
        byElement.set(k, { ref, members: [clash] });
      }
    }
  }
  const groups: ClashGroup[] = [];
  for (const [k, { ref, members }] of byElement) {
    const label = ref.name ?? ref.key;
    groups.push(makeGroup(members, `Clashes on ${ref.tag} ${label}`, undefined, `elem:${k}`));
  }
  return groups;
}

/** Severity (critical first), then member count desc, tie-break by id asc. */
function sortGroups(groups: ClashGroup[]): ClashGroup[] {
  groups.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const count = b.members.length - a.members.length;
    if (count !== 0) return count;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return groups;
}

/**
 * Group a duplicate result into coincident **sets** — one finding per set of
 * objects occupying the same place, rather than one per pair.
 *
 * `findDuplicates` reports pairwise. N coincident copies of one object therefore
 * produce N(N−1)/2 rows and each copy is named in N−1 of them, so three
 * triplicated columns read as nine findings with every object mentioned twice.
 * No row is literally repeated, but the list badly overstates the problem.
 *
 * The partition here is the **connected components of the pair graph**: every
 * reported clash is an edge between two model-qualified elements, and each
 * component is one "these N objects are coincident" finding. Unlike
 * `groupClashes({ by: 'cluster' })` this needs no epsilon and cannot fuse two
 * unrelated duplicate sets that merely stand within a cluster radius of each
 * other — it uses only the pairs the detector actually reported.
 *
 * Two properties worth stating plainly:
 *
 * - **Transitivity is approximated, knowingly.** A≈B and B≈C under an IoU
 *   threshold does not imply A≈C, yet connected components put all three in one
 *   set. We accept that: a chain of near-coincident objects is a single
 *   coordination issue, and the strict alternative (maximal cliques) is
 *   exponential and would put the same object back into several findings —
 *   the exact complaint this grouping exists to answer.
 * - **Sets may span models.** Identity is `(model, key, ref)`, so the same
 *   object delivered in two files groups correctly, and two files that happen to
 *   reuse a key for different objects do not. `ref` is in there because a key
 *   can repeat *within* one model too — a file with duplicated GlobalIds, which
 *   is exactly the defect a duplicate hunt is looking for; on `(model, key)`
 *   alone those two elements collapsed into one node and the set they form
 *   counted "1 coincident object". Adding `ref` only ever splits nodes, never
 *   merges them.
 *
 * Components are computed per `rule`, so a mixed result never fuses a duplicate
 * pair with a discipline clash. Severity is the most severe member severity: a
 * set containing any exact-duplicate (`major`) pair surfaces as `major`.
 *
 * `ClashResult` is untouched — the panel, grouping modes and BCF export keep
 * consuming the pairwise shape; this is a reporting view over it.
 */
export function groupDuplicateSets(result: ClashResult): ClashGroup[] {
  const byRule = new Map<string, Clash[]>();
  for (const clash of result.clashes) {
    const bucket = byRule.get(clash.rule);
    if (bucket) {
      bucket.push(clash);
    } else {
      byRule.set(clash.rule, [clash]);
    }
  }

  const groups: ClashGroup[] = [];

  for (const bucket of byRule.values()) {
    // Number the participating elements in first-seen order; every clash is one
    // edge between two of those nodes.
    const nodeOf = new Map<string, number>();
    const idOf = (ref: ClashElementRef): number => {
      const k = `${qualifiedKey(ref.model, ref.key)}#${ref.ref}`;
      const existing = nodeOf.get(k);
      if (existing !== undefined) return existing;
      const assigned = nodeOf.size;
      nodeOf.set(k, assigned);
      return assigned;
    };
    const edges = bucket.map((clash) => [idOf(clash.a), idOf(clash.b)] as const);

    const { find, union } = createUnionFind(nodeOf.size);
    for (const [a, b] of edges) {
      union(a, b);
    }

    // Collect each component's member clashes and its distinct element count —
    // the latter is what the reader cares about ("these 3 objects are the same"),
    // and it is NOT the member count once a set grows past a pair.
    const components = new Map<number, { members: Clash[]; nodes: Set<number>; tags: Set<string> }>();
    for (let i = 0; i < bucket.length; i += 1) {
      const clash = bucket[i];
      const root = find(edges[i][0]);
      let comp = components.get(root);
      if (!comp) {
        comp = { members: [], nodes: new Set(), tags: new Set() };
        components.set(root, comp);
      }
      comp.members.push(clash);
      comp.nodes.add(edges[i][0]);
      comp.nodes.add(edges[i][1]);
      comp.tags.add(clash.a.tag);
      comp.tags.add(clash.b.tag);
    }

    for (const comp of components.values()) {
      const count = comp.nodes.size;
      const tag = comp.tags.size === 1 ? `${[...comp.tags][0]} ` : '';
      const members = [...comp.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      groups.push(
        makeGroup(members, `${count} coincident ${tag}objects`, undefined, 'duplicate-set'),
      );
    }
  }

  return sortGroups(groups);
}

/**
 * Group a clash result. `Clash` carries no storey, so `by: 'storey'` falls back
 * to rule grouping (see module notes / report) rather than inventing a field.
 */
export function groupClashes(result: ClashResult, opts: GroupOptions): ClashGroup[] {
  const clashes = result.clashes;
  let groups: ClashGroup[];

  switch (opts.by) {
    case 'cluster':
      groups = clusterGroups(clashes, opts.epsilon ?? DEFAULT_EPSILON);
      break;
    case 'rule':
      groups = ruleGroups(clashes);
      break;
    case 'typePair':
      groups = typePairGroups(clashes);
      break;
    case 'element':
      groups = elementGroups(clashes);
      break;
    case 'storey':
      // Clash carries no storey; degrade to rule grouping. See notes.
      groups = ruleGroups(clashes);
      break;
    default: {
      const exhaustive: never = opts.by;
      throw new Error(`Unknown grouping mode: ${String(exhaustive)}`);
    }
  }

  return sortGroups(groups);
}

/** Re-exported for callers that want the cluster centre of a group's bounds. */
export { center as groupCenter };
