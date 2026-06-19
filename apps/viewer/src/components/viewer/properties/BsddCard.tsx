/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD (buildingSMART Data Dictionary) integration card.
 *
 * Shows schema-defined property sets and properties for the selected
 * IFC entity type, fetched live from the bSDD API.  Users can add
 * properties to the element in one click.
 */

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, type UIEvent } from 'react';
import { BookOpen, Plus, Check, Loader2, ExternalLink, ChevronDown, ChevronRight, ArrowRight, Library, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { ComboInput } from '@/components/ui/combo-input';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { QuantityType } from '@ifc-lite/data';
import {
  fetchClassInfo,
  fetchClassByUri,
  fetchAllDictionaries,
  listDictionaryClasses,
  searchDictionaryClasses,
  bsddDataTypeLabel,
  IFC_DICTIONARY,
  type BsddClassInfo,
  type BsddClassProperty,
  type BsddDictionary,
  type BsddSearchResult,
} from '@/services/bsdd';

/** How many classes to fetch per page when browsing a non-IFC dictionary. */
const CLASS_PAGE_SIZE = 50;
import { toPropertyValueType, defaultValue } from './bsddInlineValue.js';

// ---------------------------------------------------------------------------
// Helpers for Qto_* (quantity set) detection and mapping
// ---------------------------------------------------------------------------

/** Returns true when the property set name denotes a quantity set */
function isQuantitySet(psetName: string): boolean {
  return psetName.startsWith('Qto_');
}

/** Infer QuantityType from bSDD unit strings */
function inferQuantityType(units: string[] | null): QuantityType {
  if (!units || units.length === 0) return QuantityType.Count;
  const u = units[0].toLowerCase();
  if (u === 'm' || u === 'mm' || u === 'cm') return QuantityType.Length;
  if (u.includes('m²') || u.includes('m2')) return QuantityType.Area;
  if (u.includes('m³') || u.includes('m3')) return QuantityType.Volume;
  if (u === 'kg' || u === 'g' || u === 't') return QuantityType.Weight;
  if (u === 's' || u === 'h' || u === 'min') return QuantityType.Time;
  return QuantityType.Count;
}

// Inline-value decision logic lives in ./bsddInlineValue.ts so it can be
// unit-tested without the component's React/store/Radix dependency graph.

/** bSDD properties with null propertySet are IFC entity-level attributes */
const BSDD_ATTRIBUTES_GROUP = 'Attributes';

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface BsddCardProps {
  /** IFC type name of the selected entity, e.g. "IfcWall" */
  entityType: string;
  /** Model ID for mutations */
  modelId: string;
  /** Express ID of the entity to add properties to */
  entityId: number;
  /** Names of property sets already present on the entity */
  existingPsets: string[];
  /** Names of properties already present on the entity (flat list: "PsetName:PropName") */
  existingProps: Set<string>;
  /** Names of quantity sets already present on the entity */
  existingQsets?: string[];
  /** Names of quantities already present (flat list: "QsetName:QuantName") */
  existingQuants?: Set<string>;
  /** Names of entity-level attributes that already have values */
  existingAttributes?: Set<string>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BsddCard({
  entityType,
  modelId,
  entityId,
  existingPsets,
  existingProps,
  existingQsets = [],
  existingQuants = new Set<string>(),
  existingAttributes = new Set<string>(),
}: BsddCardProps) {
  const [classInfo, setClassInfo] = useState<BsddClassInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPsets, setExpandedPsets] = useState<Set<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());

  // Source-dictionary picker: the whole bSDD catalogue (searchable), and the
  // current search text. The committed choice lives in the store (issue #1219).
  const [allDictionaries, setAllDictionaries] = useState<BsddDictionary[]>([IFC_DICTIONARY]);
  const [dictQuery, setDictQuery] = useState('');

  // Non-IFC class picker: the user browses the dictionary's classes in a
  // paginated, scrollable list (a dictionary can hold thousands), optionally
  // narrowed by a text filter, then picks one to read its properties.
  const [classQuery, setClassQuery] = useState('');
  const [classItems, setClassItems] = useState<BsddSearchResult[]>([]);
  const [classTotal, setClassTotal] = useState(0);
  const [classOffset, setClassOffset] = useState(0);
  const [classLoading, setClassLoading] = useState(false);
  const [selectedClass, setSelectedClass] = useState<BsddSearchResult | null>(null);
  const classSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token: every reset/filter bumps it so a slow in-flight page that
  // resolves after the dictionary/filter changed is discarded, not appended.
  const classReqRef = useRef(0);
  // The class list grows to fill the panel's remaining height (the Radix
  // ScrollArea wraps content in a `display:table` div, so flexbox can't size it
  // — we measure instead). Browse mode only; a picked class uses a compact list
  // so its properties get room below.
  const classListRef = useRef<HTMLDivElement | null>(null);
  const [classListMaxH, setClassListMaxH] = useState<number | undefined>(undefined);

  const bsddDictionary = useViewerStore((s) => s.bsddDictionary);
  const setBsddDictionary = useViewerStore((s) => s.setBsddDictionary);
  const setProperty = useViewerStore((s) => s.setProperty);
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
  const setQuantity = useViewerStore((s) => s.setQuantity);
  const createQuantitySet = useViewerStore((s) => s.createQuantitySet);
  const storeSetAttribute = useViewerStore((s) => s.setAttribute);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  const setEditEnabled = useViewerStore((s) => s.setEditEnabled);
  const setPropertiesActiveTab = useViewerStore((s) => s.setPropertiesActiveTab);
  const setPendingPropertyFocus = useViewerStore((s) => s.setPendingPropertyFocus);

  const isIfcDict = bsddDictionary.uri === IFC_DICTIONARY.uri;

  // Load the full dictionary catalogue once (cached in the service) so the
  // picker can search every bSDD, not just the few related to this entity.
  useEffect(() => {
    let cancelled = false;
    fetchAllDictionaries().then(
      (dicts) => {
        if (!cancelled) setAllDictionaries(dicts.length > 0 ? dicts : [IFC_DICTIONARY]);
      },
      () => {
        if (!cancelled) setAllDictionaries([IFC_DICTIONARY]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // When the dictionary changes, reset the class browser and load its first
  // page. For a non-IFC dictionary the user browses this list to pick a class.
  useEffect(() => {
    setSelectedClass(null);
    setClassQuery('');
    setClassItems([]);
    setClassTotal(0);
    setClassOffset(0);

    if (isIfcDict) return;

    const token = ++classReqRef.current;
    setClassLoading(true);
    listDictionaryClasses(bsddDictionary.uri, 0, CLASS_PAGE_SIZE).then(
      (page) => {
        if (token !== classReqRef.current) return;
        setClassItems(page.classes);
        setClassTotal(page.total);
        setClassOffset(page.classes.length);
        setClassLoading(false);
      },
      () => {
        if (token === classReqRef.current) setClassLoading(false);
      },
    );
  }, [bsddDictionary.uri, isIfcDict]);

  // Append the next page when the list is scrolled near the bottom (browse mode
  // only — text-filtered results come back in a single page).
  const loadMoreClasses = useCallback(() => {
    if (classLoading || classQuery.trim() || classItems.length >= classTotal) return;
    const token = classReqRef.current;
    setClassLoading(true);
    listDictionaryClasses(bsddDictionary.uri, classOffset, CLASS_PAGE_SIZE).then(
      (page) => {
        if (token !== classReqRef.current) return;
        setClassItems((prev) => [...prev, ...page.classes]);
        setClassOffset((o) => o + page.classes.length);
        setClassLoading(false);
      },
      () => {
        if (token === classReqRef.current) setClassLoading(false);
      },
    );
  }, [classLoading, classQuery, classItems.length, classTotal, classOffset, bsddDictionary.uri]);

  // Debounced filter: empty → browse the full paginated list; text → search the
  // dictionary (single page). A bumped token discards any in-flight load.
  const handleClassFilter = useCallback(
    (q: string) => {
      setClassQuery(q);
      if (classSearchTimer.current) clearTimeout(classSearchTimer.current);
      const trimmed = q.trim();
      const token = ++classReqRef.current;
      setClassItems([]);
      setClassOffset(0);
      setClassLoading(true);
      classSearchTimer.current = setTimeout(() => {
        const req = trimmed
          ? searchDictionaryClasses(bsddDictionary.uri, trimmed).then((res) => ({
              classes: res,
              total: res.length,
            }))
          : listDictionaryClasses(bsddDictionary.uri, 0, CLASS_PAGE_SIZE);
        req.then(
          (page) => {
            if (token !== classReqRef.current) return;
            setClassItems(page.classes);
            setClassTotal(page.total);
            setClassOffset(page.classes.length);
            setClassLoading(false);
          },
          () => {
            if (token === classReqRef.current) setClassLoading(false);
          },
        );
      }, 250);
    },
    [bsddDictionary.uri],
  );

  const onClassListScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) loadMoreClasses();
    },
    [loadMoreClasses],
  );

  // Load the property definitions to display:
  //  - IFC dictionary → resolve by entity type name (the standard path).
  //  - other dictionary → whichever class the user has picked.
  useEffect(() => {
    let cancelled = false;
    setClassInfo(null);
    setError(null);
    setAddedKeys(new Set());

    if (!entityType) return;
    if (!isIfcDict && !selectedClass) return; // waiting for a class pick

    setLoading(true);
    const promise = isIfcDict
      ? fetchClassInfo(entityType)
      : fetchClassByUri(selectedClass!.uri, false);

    promise.then(
      (info) => {
        if (cancelled) return;
        setLoading(false);
        setClassInfo(info && info.classProperties.length > 0 ? info : null);
      },
      (err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to fetch bSDD data');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [entityType, isIfcDict, selectedClass]);

  // Clear any pending class-search debounce on unmount.
  useEffect(() => () => {
    if (classSearchTimer.current) clearTimeout(classSearchTimer.current);
  }, []);

  // Size the browse list to the space between its top and the bottom of the
  // scroll viewport (falling back to the window), so it fills the panel instead
  // of being a short fixed box. Re-measures on panel/window resize.
  useLayoutEffect(() => {
    if (isIfcDict || selectedClass) {
      setClassListMaxH(undefined);
      return;
    }
    const el = classListRef.current;
    if (!el) return;
    const viewport = el.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      const bottom = viewport ? viewport.getBoundingClientRect().bottom : window.innerHeight;
      // Leave room for the "Showing N of M" status line + a little breathing room.
      setClassListMaxH(Math.max(160, Math.floor(bottom - top - 28)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (viewport) ro.observe(viewport);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isIfcDict, selectedClass]);

  // `addedKeys` tracks what was added to THIS element, so it must reset when the
  // selection moves to a different element — even one of the same IfcType, which
  // leaves `entityType` (and the fetch above) unchanged. Without this the "N
  // added · Edit in Properties" bar and the per-row check marks leak onto the
  // next element (issue #1107 review).
  useEffect(() => {
    setAddedKeys(new Set());
  }, [entityId, modelId]);

  // Group properties by property set name
  const groupedProps = useMemo(() => {
    if (!classInfo) return new Map<string, BsddClassProperty[]>();
    const map = new Map<string, BsddClassProperty[]>();
    for (const prop of classInfo.classProperties) {
      // Null propertySet → IFC entity attributes (Name, Description, etc.)
      const psetName = prop.propertySet || BSDD_ATTRIBUTES_GROUP;
      let list = map.get(psetName);
      if (!list) {
        list = [];
        map.set(psetName, list);
      }
      list.push(prop);
    }
    return map;
  }, [classInfo]);

  const togglePset = useCallback((name: string) => {
    setExpandedPsets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleAddProperty = useCallback(
    (psetName: string, prop: BsddClassProperty) => {
      let normalizedModelId = modelId;
      if (modelId === 'legacy') normalizedModelId = '__legacy__';

      if (psetName === BSDD_ATTRIBUTES_GROUP) {
        // Route entity-level attributes (Name, Description, ObjectType, Tag,
        // PredefinedType, etc.). Created empty — the value is filled in
        // afterwards in the Properties tab (issue #1107).
        storeSetAttribute(normalizedModelId, entityId, prop.name, '');
      } else if (isQuantitySet(psetName)) {
        // Route Qto_* through quantity creation
        const qType = inferQuantityType(prop.units);
        const qsetExists = existingQsets.includes(psetName);

        if (!qsetExists) {
          createQuantitySet(normalizedModelId, entityId, psetName, [
            { name: prop.name, value: NaN, quantityType: qType, unit: prop.units?.[0] },
          ]);
        } else {
          setQuantity(
            normalizedModelId,
            entityId,
            psetName,
            prop.name,
            NaN,
            qType,
            prop.units?.[0],
          );
        }
      } else {
        // Route Pset_* / other through property creation, with the correct
        // bSDD-derived value type so the inline editor shows the right control.
        const valueType = toPropertyValueType(prop.dataType);
        const value = defaultValue(prop.dataType);
        const psetExists = existingPsets.includes(psetName);

        if (!psetExists) {
          createPropertySet(normalizedModelId, entityId, psetName, [
            { name: prop.name, value, type: valueType },
          ]);
        } else {
          setProperty(
            normalizedModelId,
            entityId,
            psetName,
            prop.name,
            value,
            valueType,
          );
        }
      }

      bumpMutationVersion();
      setAddedKeys((prev) => new Set(prev).add(`${psetName}:${prop.name}`));

      // Stay in the bSDD card — the user may want to add more (issue #1107).
      // Don't yank them to the Properties tab or flip edit mode here. Instead
      // ARM a one-shot focus on the new row; the card's "Edit in Properties"
      // bar is the deliberate jump, and only THEN do we enter edit mode and
      // scroll/highlight the row. Pset_* properties are the only inline-
      // editable target, so attributes and Qto_* quantities just confirm.
      if (psetName !== BSDD_ATTRIBUTES_GROUP && !isQuantitySet(psetName)) {
        setPendingPropertyFocus({ modelId, entityId, psetName, propName: prop.name });
        toast.success(`Added "${prop.name}" — open Properties to set its value`);
      } else {
        toast.success(`Added "${prop.name}"`);
      }
    },
    [modelId, entityId, existingPsets, existingQsets, setProperty, createPropertySet, setQuantity, createQuantitySet, storeSetAttribute, bumpMutationVersion, setPendingPropertyFocus],
  );

  const handleAddAllInPset = useCallback(
    (psetName: string, props: BsddClassProperty[]) => {
      let normalizedModelId = modelId;
      if (modelId === 'legacy') normalizedModelId = '__legacy__';

      const isAttrGroup = psetName === BSDD_ATTRIBUTES_GROUP;

      // Determine which "existing" set to check against
      const existingSet = isAttrGroup
        ? existingAttributes
        : isQuantitySet(psetName)
          ? existingQuants
          : existingProps;

      // For attributes, key is just the name; for props/quants, key is "PsetName:PropName"
      const toAdd = props.filter(
        (p) => {
          const key = isAttrGroup ? p.name : `${psetName}:${p.name}`;
          const addedKey = `${psetName}:${p.name}`;
          return !existingSet.has(key) && !addedKeys.has(addedKey);
        },
      );
      if (toAdd.length === 0) return;

      if (isAttrGroup) {
        // Route entity-level attributes
        for (const p of toAdd) {
          storeSetAttribute(normalizedModelId, entityId, p.name, '');
        }
      } else if (isQuantitySet(psetName)) {
        // Route Qto_* through quantity creation
        const qsetExists = existingQsets.includes(psetName);

        if (!qsetExists) {
          createQuantitySet(
            normalizedModelId,
            entityId,
            psetName,
            toAdd.map((p) => ({
              name: p.name,
              value: NaN,
              quantityType: inferQuantityType(p.units),
              unit: p.units?.[0],
            })),
          );
        } else {
          for (const p of toAdd) {
            setQuantity(
              normalizedModelId,
              entityId,
              psetName,
              p.name,
              NaN,
              inferQuantityType(p.units),
              p.units?.[0],
            );
          }
        }
      } else {
        const psetExists = existingPsets.includes(psetName);

        if (!psetExists) {
          createPropertySet(
            normalizedModelId,
            entityId,
            psetName,
            toAdd.map((p) => ({
              name: p.name,
              value: defaultValue(p.dataType),
              type: toPropertyValueType(p.dataType),
            })),
          );
        } else {
          for (const p of toAdd) {
            setProperty(
              normalizedModelId,
              entityId,
              psetName,
              p.name,
              defaultValue(p.dataType),
              toPropertyValueType(p.dataType),
            );
          }
        }
      }

      bumpMutationVersion();
      setAddedKeys((prev) => {
        const next = new Set(prev);
        for (const p of toAdd) next.add(`${psetName}:${p.name}`);
        return next;
      });

      // Same as single-add: stay put, arm a one-shot focus on the first new
      // property (Pset_* only — attributes/quantities aren't inline-editable).
      const isEditableProps = !isAttrGroup && !isQuantitySet(psetName);
      if (isEditableProps) {
        setPendingPropertyFocus({ modelId, entityId, psetName, propName: toAdd[0].name });
      }
      toast.success(
        `Added ${toAdd.length} ${psetName} ${toAdd.length === 1 ? 'property' : 'properties'}` +
          (isEditableProps ? ' — open Properties to set values' : ''),
      );
    },
    [modelId, entityId, existingPsets, existingQsets, existingProps, existingQuants, existingAttributes, addedKeys, setProperty, createPropertySet, setQuantity, createQuantitySet, storeSetAttribute, bumpMutationVersion, setPendingPropertyFocus],
  );

  // The deliberate "take me to what I just added" action behind the card's
  // "Edit in Properties" bar. Switching to the Properties tab + entering edit
  // mode is what "go edit" means; the Properties panel then consumes any armed
  // pendingPropertyFocus to scroll to and highlight the exact row.
  const goToProperties = useCallback(() => {
    setPropertiesActiveTab('properties');
    setEditEnabled(true);
  }, [setPropertiesActiveTab, setEditEnabled]);

  // The "Edit in Properties" bar only makes sense for things that ARE editable
  // on the Properties tab: Pset_* properties and entity attributes. Qto_*
  // quantities render read-only on a different tab, so a quantity-only add must
  // not surface the bar (it would dump the user on the wrong tab). Keys begin
  // with their set name, so a `Qto_` prefix flags a quantity (issue #1107).
  const editableAddedCount = useMemo(
    () => Array.from(addedKeys).filter((k) => !k.startsWith('Qto_')).length,
    [addedKeys],
  );

  // ---- Source-dictionary picker (searchable over the whole bSDD catalogue) ----
  const dictByLabel = useMemo(() => {
    const m = new Map<string, BsddDictionary>();
    for (const d of allDictionaries) m.set(d.name, d);
    return m;
  }, [allDictionaries]);
  const dictLabels = useMemo(() => allDictionaries.map((d) => d.name), [allDictionaries]);

  const handleDictQuery = useCallback(
    (next: string) => {
      const match = dictByLabel.get(next);
      if (match) {
        // A real dictionary was chosen — commit it and clear the query so the
        // input's placeholder shows the selection (rather than the typed text).
        if (match.uri !== bsddDictionary.uri) setBsddDictionary(match);
        setDictQuery('');
      } else {
        setDictQuery(next);
      }
    },
    [dictByLabel, bsddDictionary.uri, setBsddDictionary],
  );

  // ---- Source-dictionary picker (searchable over the whole bSDD catalogue) ----
  const dictionaryCombo = (
    <div className="flex items-center gap-1.5 px-1">
      <Library className="h-3.5 w-3.5 text-sky-500 shrink-0" />
      <ComboInput
        value={dictQuery}
        onChange={handleDictQuery}
        options={dictLabels}
        // Render the full catalogue so it can be browsed by scrolling, not just
        // filtered by typing.
        maxRendered={1000}
        placeholder={bsddDictionary.name}
        aria-label="bSDD source dictionary"
        className="h-7 text-xs"
      />
    </div>
  );

  // ---- Class browser (paginated, scrollable list of the dictionary's classes) ----
  const browseExhausted = !classQuery.trim() && classItems.length >= classTotal;
  const classBrowser = (
    <div className="space-y-1 px-1">
      <div className="flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 text-sky-500 shrink-0" />
        <Input
          value={classQuery}
          onChange={(e) => handleClassFilter(e.target.value)}
          placeholder={`Filter ${bsddDictionary.name} classes…`}
          aria-label="Filter bSDD classes"
          className="h-7 text-xs"
        />
      </div>
      <div
        ref={classListRef}
        onScroll={onClassListScroll}
        style={selectedClass ? undefined : { maxHeight: classListMaxH }}
        className={`overflow-y-auto rounded-md border border-sky-200/60 dark:border-sky-800/40 divide-y divide-sky-100/70 dark:divide-sky-900/30 ${
          selectedClass ? 'max-h-44' : ''
        }`}
      >
        {classItems.map((c) => {
          const isSel = selectedClass?.uri === c.uri;
          return (
            <button
              key={c.uri}
              type="button"
              onClick={() => setSelectedClass(c)}
              title={`${c.code} · ${c.name}`}
              className={`flex w-full items-baseline gap-1.5 px-2 py-1 text-left text-xs overflow-hidden transition-colors ${
                isSel
                  ? 'bg-sky-100 dark:bg-sky-900/40'
                  : 'hover:bg-sky-50/60 dark:hover:bg-sky-900/20'
              }`}
            >
              <span className="font-mono text-[10px] text-sky-600 dark:text-sky-400 shrink-0">{c.code}</span>
              <span className="truncate text-zinc-600 dark:text-zinc-300">{c.name}</span>
            </button>
          );
        })}
        {classLoading && (
          <div className="flex items-center justify-center gap-1.5 px-2 py-2 text-[10px] text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {!classLoading && classItems.length === 0 && (
          <div className="px-2 py-3 text-center text-[10px] text-zinc-400">No classes found</div>
        )}
      </div>
      {classItems.length > 0 && (
        <div className="px-1 text-[10px] text-zinc-400">
          {classQuery.trim()
            ? `${classItems.length} match${classItems.length === 1 ? '' : 'es'}`
            : `Showing ${classItems.length} of ${classTotal}${browseExhausted ? '' : ' · scroll for more'}`}
        </div>
      )}
    </div>
  );

  // The property body for whatever is resolved (IFC type, or the picked class).
  const showProperties = !!classInfo && groupedProps.size > 0;
  const propertyEmpty = !loading && !error && !showProperties && (isIfcDict || !!selectedClass);

  return (
    <div className="space-y-2 w-full min-w-0 overflow-hidden">
      {dictionaryCombo}
      {!isIfcDict && classBrowser}

      {loading && (
        <div className="flex items-center gap-2 px-3 py-6 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Loading {isIfcDict ? bsddDictionary.name : selectedClass?.name} data…</span>
        </div>
      )}

      {!loading && error && (
        <div className="px-3 py-4 text-xs text-red-500/70">
          <p>Could not load bSDD data: {error}</p>
        </div>
      )}

      {propertyEmpty && (
        <div className="flex flex-col items-center justify-center text-center px-4 py-6 text-xs text-zinc-400 gap-2">
          <BookOpen className="h-6 w-6 text-zinc-300 dark:text-zinc-600" />
          <p>
            {isIfcDict ? (
              <>
                No <span className="font-medium">{bsddDictionary.name}</span> properties for{' '}
                <span className="font-mono font-medium">{entityType}</span>
              </>
            ) : (
              <>
                No properties defined on <span className="font-medium">{selectedClass?.name}</span>
              </>
            )}
          </p>
          {!isIfcDict && (
            <button
              type="button"
              onClick={() => setBsddDictionary(IFC_DICTIONARY)}
              className="mt-1 text-sky-500 hover:text-sky-600 underline underline-offset-2"
            >
              Back to {IFC_DICTIONARY.name}
            </button>
          )}
        </div>
      )}

      {showProperties && classInfo && (<>
      {/* Header with class description */}
      {classInfo.definition && (
        <div className="px-1 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          {classInfo.definition}
        </div>
      )}

      {/* "Go edit" bar — the deliberate jump to the Properties tab. Appears
          once anything has been added this session so the user can keep adding
          here, then cross over to set values when ready (issue #1107). Kept out
          of the scroll body's sticky region (Radix ScrollArea breaks sticky)
          and pinned at the top where attention returns after an add. */}
      {editableAddedCount > 0 && (
        <button
          type="button"
          onClick={goToProperties}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border-2 border-emerald-300/70 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
        >
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{editableAddedCount} added · Edit in Properties</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
        </button>
      )}

      {/* Property sets from bSDD */}
      {Array.from(groupedProps.entries()).map(([psetName, props]) => {
        const isExpanded = expandedPsets.has(psetName);
        const isAttrGroup = psetName === BSDD_ATTRIBUTES_GROUP;
        const isQto = isQuantitySet(psetName);
        // For attributes, check against existingAttributes (keyed by name only);
        // for quants/props, check against existingQuants/existingProps (keyed by "PsetName:PropName")
        const existingSet = isAttrGroup ? existingAttributes : isQto ? existingQuants : existingProps;
        const makeKey = (p: BsddClassProperty) => isAttrGroup ? p.name : `${psetName}:${p.name}`;
        const allAlreadyExist = props.every(
          (p) =>
            existingSet.has(makeKey(p)) ||
            addedKeys.has(`${psetName}:${p.name}`),
        );
        const psetExistsOnEntity = isAttrGroup
          ? true // Attributes section always exists on the entity
          : isQto
            ? existingQsets.includes(psetName)
            : existingPsets.includes(psetName);
        const addableCount = props.filter(
          (p) =>
            !existingSet.has(makeKey(p)) &&
            !addedKeys.has(`${psetName}:${p.name}`),
        ).length;

        return (
          <div
            key={psetName}
            className="border-2 border-sky-200/60 dark:border-sky-800/40 bg-sky-50/20 dark:bg-sky-950/10 w-full overflow-hidden"
          >
            {/* Pset header */}
            <button
              className="flex items-center gap-1.5 w-full p-2 hover:bg-sky-50 dark:hover:bg-sky-900/20 text-left transition-colors overflow-hidden"
              onClick={() => togglePset(psetName)}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 text-sky-500 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 text-sky-500 shrink-0" />
              )}
              <span className="font-bold text-xs text-sky-800 dark:text-sky-300 truncate flex-1 min-w-0">
                {psetName}
              </span>
              <span className="text-[10px] font-mono bg-sky-100 dark:bg-sky-900/50 px-1 py-0.5 border border-sky-200 dark:border-sky-800 text-sky-600 dark:text-sky-400 shrink-0">
                {props.length}
              </span>
              {addableCount > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 p-0 shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddAllInPset(psetName, props);
                      }}
                    >
                      <Plus className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add all {addableCount} properties</TooltipContent>
                </Tooltip>
              )}
              {allAlreadyExist && (
                <Check className="h-3 w-3 text-emerald-500 shrink-0" />
              )}
            </button>

            {/* Properties */}
            {isExpanded && (
              <div className="border-t-2 border-sky-200/60 dark:border-sky-800/40 divide-y divide-sky-100 dark:divide-sky-900/30">
                {props.map((prop) => {
                  const existKey = makeKey(prop);
                  const addedKey = `${psetName}:${prop.name}`;
                  const alreadyExists = existingSet.has(existKey) || addedKeys.has(addedKey);

                  return (
                    <div
                      key={prop.name}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs overflow-hidden ${
                        alreadyExists
                          ? 'bg-emerald-50/30 dark:bg-emerald-950/10'
                          : 'hover:bg-sky-50/50 dark:hover:bg-sky-900/20'
                      }`}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-medium text-zinc-600 dark:text-zinc-400 cursor-help truncate flex-1 min-w-0">
                            {prop.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-[10px]">
                          <p className="font-medium">{prop.name}</p>
                          {prop.description && <p className="mt-0.5 text-zinc-400">{prop.description}</p>}
                          {prop.dataType && <p className="mt-0.5 text-sky-400">{bsddDataTypeLabel(prop.dataType)}</p>}
                        </TooltipContent>
                      </Tooltip>
                      {/* Add button - always visible on right. The property is
                          created with its correct bSDD data type; the value is
                          edited afterwards in the Properties tab (issue #1107). */}
                      {alreadyExists ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 p-0 shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800"
                              onClick={() => handleAddProperty(psetName, prop)}
                            >
                              <Plus className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Add to element</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer link — browse the active class on bSDD. For IFC we can build
          the URL from the entity name; other dictionaries reuse the resolved
          class URI (identifier → search host). */}
      <div className="flex items-center justify-center pt-1 pb-1">
        <a
          href={
            isIfcDict
              ? `https://search.bsdd.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/${entityType}`
              : classInfo.uri.replace(
                  'identifier.buildingsmart.org',
                  'search.bsdd.buildingsmart.org',
                )
          }
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-sky-500/70 hover:text-sky-600 transition-colors"
        >
          <ExternalLink className="h-2.5 w-2.5" />
          View on bSDD
        </a>
      </div>
      </>)}
    </div>
  );
}
