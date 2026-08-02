/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Episode factory for `ifc-lite gym`: discovery and lazy loading of the
 * World Gym generator (tools/world-gym) from the repo checkout, plus the
 * seed/family/corruption parameter parsing shared by the `--seed` CLI path
 * and mid-session `{"type":"reset","seed":n}` messages.
 *
 * The generator is dynamically imported so the published npm package (which
 * does not ship tools/world-gym) fails `--seed` with a clear, actionable
 * error while `--model` keeps working.
 */

interface GeneratedModel {
  seed: number | string;
  family: string;
  corrupted: boolean;
  content: string;
}

interface WorldGymGenerator {
  generateModel: (
    seed: number | string,
    family?: string,
    opts?: { corruptRate?: number; forceCorrupt?: boolean },
  ) => GeneratedModel;
}

/** Episode descriptor echoed on generated-episode reset lines. */
export interface EpisodeInfo {
  seed: number | string;
  family: string;
  corrupted: boolean;
}

export interface EpisodeSpec {
  seed: number | string;
  family: string;
  forceCorrupt?: boolean;
  corruptRate?: number;
}

/** Benchmark default; overwritten from benchmark/splits.mjs when loadable. */
let benchmarkCorruptRate = 0.3;
let generatorModule: WorldGymGenerator | null = null;

async function loadGenerator(): Promise<WorldGymGenerator> {
  if (generatorModule) return generatorModule;
  // Both src (vitest) and dist layouts sit 5 levels below the repo root.
  const generatorUrl = new URL('../../../../../tools/world-gym/generator.mjs', import.meta.url);
  try {
    generatorModule = (await import(generatorUrl.href)) as WorldGymGenerator;
  } catch (err) {
    throw new Error(
      `the gym episode factory needs the ifc-lite repo checkout (could not load ${generatorUrl.pathname}: ${(err as Error).message}); use --model <file.ifc> instead`,
    );
  }
  try {
    const splits = (await import(new URL('../../../../../tools/world-gym/benchmark/splits.mjs', import.meta.url).href)) as { CORRUPT_RATE?: number };
    if (typeof splits.CORRUPT_RATE === 'number') {
      benchmarkCorruptRate = splits.CORRUPT_RATE;
    } else {
      process.stderr.write(
        'gym: warning: tools/world-gym/benchmark/splits.mjs loaded but exports no numeric CORRUPT_RATE; using the compiled-in default corrupt rate 0.3\n',
      );
    }
  } catch (err) {
    // The generator itself loaded, so a broken/missing splits.mjs means the
    // episode distribution would silently drift from the benchmark spec.
    // Keep the compiled-in default, but say so.
    process.stderr.write(
      `gym: warning: could not load tools/world-gym/benchmark/splits.mjs (${(err as Error).message}); using the compiled-in default corrupt rate 0.3\n`,
    );
  }
  return generatorModule;
}

export function parseSeed(raw: unknown, source: string): number | string {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : raw;
  }
  throw new Error(`${source} must be a non-negative integer (benchmark seed) or a non-empty string`);
}

export function parseCorruptRate(raw: unknown, source: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${source} must be a number in [0, 1]`);
  }
  return n;
}

export async function generateEpisode(spec: EpisodeSpec): Promise<{ model: GeneratedModel; episode: EpisodeInfo }> {
  if (spec.forceCorrupt !== undefined && spec.corruptRate !== undefined) {
    throw new Error(
      'corrupt and corruptRate are mutually exclusive: forcing corruption on/off makes a rate meaningless',
    );
  }
  const generator = await loadGenerator();
  const opts = spec.forceCorrupt !== undefined
    ? { forceCorrupt: spec.forceCorrupt }
    : { corruptRate: spec.corruptRate ?? benchmarkCorruptRate };
  const model = generator.generateModel(spec.seed, spec.family, opts);
  return {
    model,
    episode: { seed: spec.seed, family: model.family, corrupted: model.corrupted },
  };
}
