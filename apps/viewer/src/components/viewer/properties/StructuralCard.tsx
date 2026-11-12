/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StructuralCard — surface `extractStructuralOnDemand`'s read model in the
 * Properties when the selection is a structural record: a member, connection,
 * activity, load group or case, result group or analysis model. Mirrors
 * `ScheduleCard`'s shape: a self-contained card that renders nothing when there
 * is nothing to show, so it is safe to mount unconditionally next to the other
 * property cards.
 *
 * What it shows comes from `structuralCardSections` (one data-driven list of
 * sections with EXPRESS attribute rows: the selection, then its applied load,
 * boundary and connection conditions, member-end relationships and
 * eccentricities). A member also lists its analysis model(s), the connections
 * it is joined to and the loads applied to it, and either end of the
 * physical-to-analytical link lists its counterparts. Nothing here edits
 * structural data — this is a read surface, matching layer 3
 * (`bim.structural`), which is read-only too.
 */

import { useMemo, type ReactNode } from 'react';
import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Boxes, Anchor, ArrowDownToLine, TriangleAlert, ChevronDown } from 'lucide-react';
import { formatLocaleNumber, localeCount, useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleList, formatLocaleValueList } from '@/i18n/intlFormat';
import { resolveMeasureDisplay, type UnitDisplay } from '@/lib/units/display';
import type {
  ProjectUnits,
  StructuralExtraction,
  StructuralConnectionInfo,
  StructuralActivityInfo,
  StructuralLoadInfo,
} from '@ifc-lite/parser';
import { structuralCardSubject, structuralRelatedRows } from './selectedStructuralMember';
import { structuralCardSections, type StructuralCardRow, type StructuralCardSection } from './structural-card-model';
import { PersistentCollapsible } from './PersistentCollapsible';
import { RelItem } from './RelationshipsCard';
import { INSPECTOR_SECTION, INSPECTOR_TRIGGER, INSPECTOR_TITLE, INSPECTOR_COUNT, INSPECTOR_CHEVRON, INSPECTOR_SUBHEADING } from './inspector-ui';

interface StructuralCardProps {
  /** Structural read model for the current model (or null if none/unextracted). */
  structuralData: StructuralExtraction | null;
  /** Selected entity's local express ID. */
  selectedExpressId: number | null;
  /** GUID-only fallback when no local EXPRESS identity is available; must be unique in this model. */
  selectedGlobalId?: string | null;
  sourceUnavailable?: boolean;
  /** Name and IFC class of a model-local entity, for the counterpart rows. */
  describeEntity?: (expressId: number) => { name?: string; type: string } | null;
  /** Select a model-local entity: the jump to a counterpart. */
  onSelectEntity?: (expressId: number) => void;
  /** The store's `schemaVersion`: which EXPRESS attributes a record has. */
  schemaVersion?: string;
  /** The model's declared units; null when they cannot be read, and then no unit is printed. */
  projectUnits?: ProjectUnits | null;
  /** The user's display unit per unit type, as the property and quantity cards apply it. */
  unitDisplayOverrides?: Record<string, string>;
}

export function StructuralCard({
  structuralData,
  selectedExpressId,
  selectedGlobalId, sourceUnavailable = false, describeEntity, onSelectEntity, schemaVersion, projectUnits = null,
  unitDisplayOverrides = NO_OVERRIDES,
}: StructuralCardProps) {
  const { t, locale } = useTranslation();
  const subject = useMemo(
    () => structuralCardSubject(structuralData, selectedExpressId, selectedGlobalId),
    [structuralData, selectedExpressId, selectedGlobalId],
  );
  const member = subject?.member ?? null;
  const counterparts = subject?.counterparts ?? null;

  const groupNames = useMemo(() => new Map(
    [...(structuralData?.loadGroups ?? []), ...(structuralData?.resultGroups ?? [])]
      .flatMap((group) => (group.name ? [[group.globalId, group.name] as const] : [])),
  ), [structuralData]);
  const related = useMemo(() => ({
    connections: structuralRelatedRows(structuralData?.connections ?? [], member?.connectionGlobalIds ?? []),
    activities: structuralRelatedRows(structuralData?.activities ?? [], member?.activityGlobalIds ?? []),
    models: structuralRelatedRows(structuralData?.analysisModels ?? [], member?.analysisModelGlobalIds ?? []),
  }), [member, structuralData]);
  const sections = useMemo(
    () => (structuralData ? structuralCardSections(structuralData, { expressId: selectedExpressId, globalId: selectedGlobalId }, schemaVersion) : []),
    [structuralData, selectedExpressId, selectedGlobalId, schemaVersion],
  );
  if (!structuralData || !subject) return null;
  const itemType = subject.record?.type;
  const connections = related.connections.rows;
  const activities = related.activities.rows;
  const modelLabels = related.models.rows.flatMap(model => model.name ? [model.name] : []);
  const relatedUnavailable = related.connections.unavailable || related.activities.unavailable || related.models.unavailable;
  const format = (row: StructuralCardRow) => formatCardValue(row, {
    locale,
    measure: (n, measure) => (projectUnits
      ? resolveMeasureDisplay(n, measure, projectUnits, unitDisplayOverrides)
      : { unit: null, converted: null }),
    dropped: (reason) => t('properties.structural.configurationDropped', { name: reason }),
    entity: (id) => describeEntity?.(id) ?? null,
    group: (globalId) => groupNames.get(globalId) ?? globalId,
  });

  return (
    <PersistentCollapsible
      id="structural"
      className={INSPECTOR_SECTION}
    >
      <CollapsibleTrigger className={INSPECTOR_TRIGGER}>
        <Boxes className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={INSPECTOR_TITLE}>
          {t('properties.structural.heading')}
        </span>
        {structuralData?.loadsTruncated && (
          <span
            className="flex items-center gap-1 text-2xs font-medium bg-warn-surface px-1.5 py-0.5 border border-warn-border text-warn shrink-0"
            title={t('properties.structural.loadsTruncatedTooltip')}
          >
            <TriangleAlert className="h-2.5 w-2.5" aria-hidden />
            {t('properties.structural.truncatedBadge')}
          </span>
        )}
        {itemType && (
          <span className={INSPECTOR_COUNT}>
            {itemType.replace(/^Ifc/, '')}
          </span>
        )}
        <ChevronDown className={INSPECTOR_CHEVRON} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {sourceUnavailable && <output className="block p-3 text-xs text-warn">{t('properties.structural.sourceUnavailable')}</output>}
        {relatedUnavailable && <output className="block p-3 text-xs text-warn">{t('properties.structural.relatedUnavailable')}</output>}
        <div className="pb-1">
          {sections[0] && (
            <div className="px-3 py-2 text-xs">
              <SectionRows section={sections[0]} format={format}>
                {modelLabels.length > 0 && (
                  <>
                    <span className="text-muted-foreground">{t('properties.structural.model')}</span>
                    <span className="text-foreground/90 truncate" title={modelLabels.join(', ')}>
                      {modelLabels.join(', ')}
                    </span>
                  </>
                )}
              </SectionRows>
              {sections.slice(1).map((section, i) => (
                // One resource can be held by two parents (both ends of a member share a condition): key by position.
                <div key={`${i}:${section.via}:${section.expressId}`} className="mt-1.5" style={{ marginLeft: `${(section.depth - 1) * 0.5}rem` }}>
                  <div className={INSPECTOR_SUBHEADING}>
                    <span className="font-mono">{section.via}</span>
                    <span> · {section.type}</span>
                    <span className="font-mono"> #{section.expressId}</span>
                  </div>
                  <SectionRows section={section} format={format} />
                </div>
              ))}
            </div>
          )}

          {counterparts && (
            <div className="px-3 py-2">
              <div className={INSPECTOR_SUBHEADING}>
                {t(counterparts.side === 'physical' ? 'properties.structural.physicalElements' : 'properties.structural.analyticalItems',
                  localeCount(locale, counterparts.expressIds.length))}
              </div>
              {counterparts.expressIds.map((id) => (
                <RelItem key={id} item={{ id, type: '', ...describeEntity?.(id) }} onSelect={onSelectEntity} />
              ))}
            </div>
          )}

          {connections.length > 0 && (
            <div className="px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 mb-1.5 text-violet-700 dark:text-violet-400">
                <Anchor className="h-3 w-3 shrink-0" />
                <span className="font-semibold text-2xs">
                  {t('properties.structural.connections', localeCount(locale, connections.length))}
                </span>
              </div>
              <div className="space-y-1.5 ml-1">
                {connections.map((c) => (
                  <ConnectionRow key={c.globalId} connection={c} />
                ))}
              </div>
            </div>
          )}

          {activities.length > 0 && (
            <div className="px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 mb-1.5 text-violet-700 dark:text-violet-400">
                <ArrowDownToLine className="h-3 w-3 shrink-0" />
                <span className="font-semibold text-2xs">
                  {t('properties.structural.appliedLoads', localeCount(locale, activities.length))}
                </span>
              </div>
              <div className="space-y-1.5 ml-1">
                {activities.map((a) => (
                  <ActivityRow key={a.globalId} activity={a} />
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}

function ConnectionRow({ connection }: { connection: StructuralConnectionInfo }) {
  const { t, locale } = useTranslation();
  const condition = connection.appliedCondition;
  const summary = condition ? formatDofs(condition.components, t, locale) : '';
  return (
    <div className="text-2xs">
      <div className="font-medium text-foreground/90 truncate" title={connection.name}>
        {connection.name || connection.type.replace(/^Ifc/, '')}
      </div>
      {condition && (
        <div className="text-muted-foreground ml-2 truncate" title={summary}>
          {condition.name ? `${condition.name} — ` : ''}
          {summary}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ activity }: { activity: StructuralActivityInfo }) {
  const { t, locale } = useTranslation();
  const load = activity.appliedLoad;
  return (
    <div className="text-2xs">
      <div className="font-medium text-foreground/90 truncate" title={activity.name}>
        {activity.name || activity.type.replace(/^Ifc/, '')}
        {activity.predefinedType && (
          <span className="text-muted-foreground font-normal"> · {activity.predefinedType}</span>
        )}
      </div>
      {load && (
        <div className="text-muted-foreground ml-2">
          {formatLoad(load, t, locale)}
        </div>
      )}
    </div>
  );
}

/** Render a load's own components, or — for a configuration — every entry's. */
type Translate = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;

function formatLoad(load: StructuralLoadInfo, t: Translate, locale: string): string {
  if (load.configuration) {
    const parts = load.configuration.entries.map((entry) => {
      if (!entry.value) return t('properties.structural.configurationDropped', { name: entry.dropped ?? 'unreadable' });
      const components = formatComponents(entry.value.components, t, locale);
      if (!entry.location) return components;
      const location = formatLocaleList(locale, entry.location.map((value) => formatLocaleNumber(locale, value)));
      return t('properties.structural.configurationAt', { components, location });
    });
    return formatLocaleList(locale, parts);
  }
  return formatComponents(load.components, t, locale);
}

function formatComponents(components: Record<string, number>, t: Translate, locale: string): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return t('properties.structural.noComponents');
  return formatLocaleList(locale, entries.map(([name, value]) => t('properties.structural.componentValue', {
    name,
    value: formatLocaleNumber(locale, value),
  })));
}

/** Summarize the boolean and stiffness-select branches per degree of freedom. */
function formatDofs(components: Record<string, number | boolean>, t: Translate, locale: string): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return t('properties.structural.noDofs');
  const fixed = entries.filter(([, value]) => value === true).length;
  const free = entries.filter(([, value]) => value === false).length;
  const elastic = entries.length - fixed - free;
  const label = (count: number, key: TranslationKey) => t(key, {
    count,
    countDisplay: formatLocaleNumber(locale, count),
  });
  return formatLocaleList(locale, [
    fixed > 0 ? label(fixed, 'properties.structural.fixedDofs') : null,
    elastic > 0 ? label(elastic, 'properties.structural.elasticDofs') : null,
    free > 0 ? label(free, 'properties.structural.freeDofs') : null,
  ].filter((part): part is string => part !== null));
}

/** One section's rows as the card's two-column attribute grid; `children` adds rows after them. */
function SectionRows({ section, format, children }: {
  section: StructuralCardSection;
  format: (row: StructuralCardRow) => string;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(70px,auto)_1fr] gap-x-2 gap-y-0.5 text-2xs">
      {section.rows.map((row) => {
        const text = format(row);
        return (
          <div key={row.attribute} className="contents">
            <span className="text-muted-foreground">{row.attribute}</span>
            <span className="font-mono text-foreground/90 truncate" title={text}>{text}</span>
          </div>
        );
      })}
      {children}
    </div>
  );
}

const NO_OVERRIDES: Record<string, string> = {};
/** Enough digits for a structural value the file states (0.0125 m, 1,000,000,000 N/m) without float noise. */
// `roundingPriority` is ES2023 Intl; the viewer's lib is ES2022, hence the cast.
const CARD_NUMBER = { maximumFractionDigits: 3, maximumSignificantDigits: 6, roundingPriority: 'morePrecision' } as Intl.NumberFormatOptions;

interface CardValueFormat {
  locale: string;
  /** A number in its measure: the unit to print and the value converted to the user's display unit, if any. */
  measure: (value: number, measure: string) => UnitDisplay;
  /** Name and IFC class of a model-local entity. */
  entity: (expressId: number) => { name?: string; type: string } | null;
  /** Display name of a load or result group. */
  group: (globalId: string) => string;
  /** Why a load configuration slot carries no load. */
  dropped: (reason: string) => string;
}

/** A row value as text: numbers in the locale with the measure's unit, references by id and class. */
function formatCardValue(row: StructuralCardRow, f: CardValueFormat): string {
  const { value } = row;
  const { measure } = row;
  // The unit depends on the measure alone, so any finite value resolves it.
  const unit = measure ? f.measure(0, measure).unit : null;
  const number = (n: number) => formatLocaleNumber(f.locale, (measure ? f.measure(n, measure).converted : null) ?? n, CARD_NUMBER);
  const withUnit = (text: string) => (unit ? `${text} ${unit}` : text);
  const reference = (id: number) => {
    const target = f.entity(id);
    return target ? `#${id} ${target.name || target.type}` : `#${id}`;
  };
  if (typeof value === 'number') return withUnit(number(value));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  if ('ref' in value) return reference(value.ref);
  if ('refs' in value) {
    return formatLocaleValueList(f.locale, value.refs.map((ref) => (typeof ref === 'number' ? reference(ref) : f.dropped(ref.dropped))));
  }
  if ('globalId' in value) return f.group(value.globalId);
  if ('globalIds' in value) return formatLocaleList(f.locale, value.globalIds.map(f.group));
  const items = (value as readonly (number | readonly number[])[]).map((item) => (typeof item === 'number'
    ? number(item)
    : `(${formatLocaleValueList(f.locale, item.map(number))})`));
  return withUnit(formatLocaleValueList(f.locale, items));
}
