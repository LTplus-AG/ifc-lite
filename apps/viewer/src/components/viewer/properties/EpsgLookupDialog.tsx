/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EPSG lookup dialog - search by code or name.
 *
 * Uses the local full EPSG index from @ifc-lite/data so search remains stable
 * and works offline once the bundle is loaded.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, Globe } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  lookupEpsgByCode,
  searchEpsgIndex,
  type EpsgIndexEntry,
} from '@ifc-lite/data';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation, type TranslationKey } from '@/i18n';
import { EpsgLookupError } from './EpsgLookupError';

export interface EpsgResult {
  code: string;
  name: string;
  area: string;
  unit: string;
  kind?: string;
  datum?: string;
  projection?: string;
}

const RECENT_EPSG_STORAGE_KEY = 'ifc-lite:recent-epsg-codes';
const MAX_RECENT_CODES = 6;
const MAX_STARTER_RESULTS = 8;

const GLOBAL_DEFAULT_CODES = [
  '4326',
  '3857',
  '32632',
  '32633',
  '27700',
  '2154',
  '28992',
  '2263',
];

const REGIONAL_CODES: Record<string, string[]> = {
  AU: ['7855', '28355'],
  AT: ['31255', '31256', '31257'],
  BE: ['31370'],
  CH: ['2056', '21781'],
  DE: ['25832', '25833', '5555'],
  FR: ['2154'],
  GB: ['27700'],
  HK: ['2326'],
  IT: ['6706'],
  JP: ['3092', '3093', '3094', '3095'],
  NL: ['28992', '7415'],
  NZ: ['2193'],
  SE: ['3006'],
  SG: ['3414'],
  US: ['2263', '2227', '26917', '6339'],
};

const TIMEZONE_REGION_CODES: Array<{ prefix: string; region: string }> = [
  { prefix: 'Europe/Zurich', region: 'CH' },
  { prefix: 'Europe/Berlin', region: 'DE' },
  { prefix: 'Europe/Vienna', region: 'AT' },
  { prefix: 'Europe/London', region: 'GB' },
  { prefix: 'Europe/Paris', region: 'FR' },
  { prefix: 'Europe/Amsterdam', region: 'NL' },
  { prefix: 'Europe/Brussels', region: 'BE' },
  { prefix: 'Europe/Rome', region: 'IT' },
  { prefix: 'Europe/Stockholm', region: 'SE' },
  { prefix: 'America/New_York', region: 'US' },
  { prefix: 'America/Los_Angeles', region: 'US' },
  { prefix: 'America/Chicago', region: 'US' },
  { prefix: 'America/Denver', region: 'US' },
  { prefix: 'Asia/Tokyo', region: 'JP' },
  { prefix: 'Asia/Hong_Kong', region: 'HK' },
  { prefix: 'Asia/Singapore', region: 'SG' },
  { prefix: 'Australia/', region: 'AU' },
  { prefix: 'Pacific/Auckland', region: 'NZ' },
];

function toDialogResult(entry: EpsgIndexEntry): EpsgResult {
  return {
    code: entry.code,
    name: entry.name,
    area: entry.area,
    unit: entry.unit,
    kind: entry.kind,
    datum: entry.datum || undefined,
    projection: entry.projection || undefined,
  };
}

// ── Bundled offline fallback (common BIM/GIS codes) ────────────────────

const COMMON_CRS: EpsgResult[] = [
  { code: '4326', name: 'WGS 84', area: 'World', unit: 'degree', kind: 'Geographic', datum: 'WGS84' },
  { code: '3857', name: 'WGS 84 / Pseudo-Mercator', area: 'World', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
  { code: '4258', name: 'ETRS89', area: 'Europe', unit: 'degree', kind: 'Geographic', datum: 'ETRS89' },
  { code: '25832', name: 'ETRS89 / UTM zone 32N', area: 'Europe 6°-12°E', unit: 'metre', kind: 'Projected', datum: 'ETRS89' },
  { code: '25833', name: 'ETRS89 / UTM zone 33N', area: 'Europe 12°-18°E', unit: 'metre', kind: 'Projected', datum: 'ETRS89' },
  { code: '27700', name: 'OSGB 1936 / British National Grid', area: 'United Kingdom', unit: 'metre', kind: 'Projected', datum: 'OSGB 1936' },
  { code: '2154', name: 'RGF93 v1 / Lambert-93', area: 'France', unit: 'metre', kind: 'Projected', datum: 'RGF93 v1' },
  { code: '28992', name: 'Amersfoort / RD New', area: 'Netherlands', unit: 'metre', kind: 'Projected', datum: 'Amersfoort' },
  { code: '2263', name: 'NAD83 / New York Long Island (ftUS)', area: 'USA - New York - SPCS - Long Island', unit: 'US survey foot', kind: 'Projected', datum: 'NAD83' },
  { code: '26917', name: 'NAD83 / UTM zone 17N', area: 'North America - 84°W to 78°W', unit: 'metre', kind: 'Projected', datum: 'NAD83' },
  { code: '32632', name: 'WGS 84 / UTM zone 32N', area: 'World 6°-12°E', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
  { code: '32633', name: 'WGS 84 / UTM zone 33N', area: 'World 12°-18°E', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
];

function readRecentCodes(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_EPSG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT_CODES);
  } catch {
    return [];
  }
}

function writeRecentCode(code: string): void {
  if (typeof window === 'undefined') return;
  try {
    const deduped = [code, ...readRecentCodes().filter(existing => existing !== code)].slice(0, MAX_RECENT_CODES);
    window.localStorage.setItem(RECENT_EPSG_STORAGE_KEY, JSON.stringify(deduped));
  } catch {
    // Ignore storage failures.
  }
}

function getRegionHints(): string[] {
  if (typeof window === 'undefined') return [];

  const timeZoneHints: string[] = [];
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const languageHints = new Set<string>();

  for (const language of languages) {
    const parts = language.replace('_', '-').split('-');
    const region = parts[1]?.toUpperCase();
    if (region && region in REGIONAL_CODES) languageHints.add(region);
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const candidate of TIMEZONE_REGION_CODES) {
    if (timeZone.startsWith(candidate.prefix)) {
      timeZoneHints.push(candidate.region);
    }
  }

  const orderedTimeZoneHints = Array.from(new Set(timeZoneHints));
  if (orderedTimeZoneHints.length > 0) {
    return orderedTimeZoneHints;
  }

  return Array.from(languageHints);
}

async function getStarterResults(): Promise<EpsgResult[]> {
  const recentCodes = readRecentCodes();
  const regionHints = getRegionHints();
  const candidateCodes = [
    ...recentCodes,
    ...regionHints.flatMap(region => REGIONAL_CODES[region] ?? []),
    ...GLOBAL_DEFAULT_CODES,
  ];

  const seen = new Set<string>();
  const dedupedCodes: string[] = [];

  for (const code of candidateCodes) {
    if (seen.has(code)) continue;
    seen.add(code);
    dedupedCodes.push(code);
    if (dedupedCodes.length >= MAX_STARTER_RESULTS) break;
  }

  const entries = await Promise.all(dedupedCodes.map(code => lookupEpsgByCode(code)));
  const results = entries
    .filter((entry): entry is EpsgIndexEntry => Boolean(entry))
    .map(entry => toDialogResult(entry));

  if (results.length > 0) {
    return results;
  }

  return COMMON_CRS.slice(0, MAX_STARTER_RESULTS);
}

// ── Dialog component ───────────────────────────────────────────────────

interface EpsgLookupDialogProps {
  onSelect: (result: EpsgResult) => void;
  children?: React.ReactNode;
}
export function EpsgLookupDialog({ onSelect, children }: EpsgLookupDialogProps) {
  const focusSearch = useCallback((node: HTMLInputElement | null) => { node?.focus(); }, []);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EpsgResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resetSearchState = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setQuery('');
    setResults([]);
    setLoading(false);
    setErrorKey(null);
  }, []);

  const localIndex = useMemo(
    () => COMMON_CRS.map(crs => ({ ...crs, _s: `${crs.code} ${crs.name} ${crs.area} ${crs.datum ?? ''} ${crs.projection ?? ''}`.toLowerCase() })),
    [],
  );

  const search = useCallback(async (searchQuery: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setResults([]);
      setErrorKey(null);
      return;
    }

    const queryLower = trimmed.toLowerCase();
    const isCode = /^\d+$/.test(trimmed);
    const localMatches = localIndex
      .filter(c => isCode ? c.code.startsWith(trimmed) : c._s.includes(queryLower))
      .slice(0, 10);

    if (localMatches.length > 0) {
      setResults(localMatches);
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setErrorKey(null);

    try {
      const resolved = isCode
        ? await lookupEpsgByCode(trimmed, { prefix: true, limit: 25 })
        : await searchEpsgIndex(trimmed, { limit: 25 });
      if (controller.signal.aborted) return;

      const authoritativeMatches = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
      const dedupedResults: EpsgResult[] = [];
      const seenCodes = new Set<string>();
      for (const candidate of [
        ...localMatches.map(result => ({ code: result.code, result })),
        ...authoritativeMatches.map(entry => ({ code: entry.code, result: toDialogResult(entry) })),
      ]) {
        if (seenCodes.has(candidate.code)) continue;
        seenCodes.add(candidate.code);
        dedupedResults.push(candidate.result);
        if (dedupedResults.length >= 25) break;
      }

      if (dedupedResults.length > 0) {
        setResults(dedupedResults);
        setErrorKey(null);
      } else if (localMatches.length === 0) {
        setResults([]);
        setErrorKey('properties.epsgLookup.noResults');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[EPSG Lookup] Local search failed', err);
      if (localMatches.length === 0) {
        setErrorKey('properties.epsgLookup.searchUnavailable');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [localIndex]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 250);
  }, [search]);

  const handleSelect = useCallback((result: EpsgResult) => {
    writeRecentCode(result.code);
    onSelect(result);
    setOpen(false);
    resetSearchState();
  }, [onSelect, resetSearchState]);

  useEffect(() => {
    if (!open || query) return;

    let cancelled = false;

    void getStarterResults()
      .then(starterResults => {
        if (cancelled) return;
        setResults(starterResults);
        setErrorKey(null);
      })
      .catch(() => {
        if (cancelled) return;
        setResults(COMMON_CRS.slice(0, MAX_STARTER_RESULTS));
        setErrorKey(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, query]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) resetSearchState();
      }}
    >
      <DialogTrigger asChild>
        {children || (
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-mono text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors px-1.5 py-0.5 border border-teal-300/50 dark:border-teal-700/50 hover:bg-teal-50 dark:hover:bg-teal-950/50"
          >
            <Search className="h-2.5 w-2.5" />
            {t('properties.epsgLookup.triggerButton')}
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-sm gap-0 p-0 overflow-hidden" hideCloseButton>
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4 text-teal-500" />
            {t('properties.epsgLookup.title')}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t('properties.epsgLookup.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-3">
          <Input
            ref={focusSearch}
            placeholder={t('properties.epsgLookup.searchPlaceholder')}
            value={query}
            onChange={handleInputChange}
            leftIcon={loading ? <Spinner size="sm" /> : <Search className="h-3.5 w-3.5" />}
            className="h-8 text-xs"
          />
        </div>

        <EpsgLookupError errorKey={errorKey} />

        {results.length > 0 && (
          <div className="border-t overflow-y-auto max-h-[280px]">
            {results.map((result) => (
              <button
                key={result.code}
                className="w-full text-left px-4 py-2 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0"
                onClick={() => handleSelect(result)}
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <code className="text-xs font-bold text-teal-600 dark:text-teal-400 shrink-0">{result.code}</code>
                  <span className="text-xs text-foreground truncate">{result.name}</span>
                  {result.kind && (
                    <span className="text-xs text-muted-foreground shrink-0 ml-auto">{result.kind}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  {result.area && <span className="truncate">{result.area}</span>}
                  {result.datum && <span className="shrink-0">{result.datum}</span>}
                  {result.unit && <span className="shrink-0">{result.unit}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
