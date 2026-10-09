/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locale catalogues for the changelog sentences. Facet and constraint
 * wording comes from `@ifc-lite/ids` (via `describeFacet` /
 * `formatConstraint`), so a changelog and a validation report never
 * describe the same facet differently; only the change frames live here.
 */

import type { RequirementOptionality, SupportedLocale } from '@ifc-lite/ids';
import type { Section } from '../document/types.js';
import type { InfoField, SpecCardinality } from '../ops/types.js';

export interface ChangelogCatalogue {
  section: Record<Section, string>;
  optionality: Record<RequirementOptionality, string>;
  cardinality: Record<SpecCardinality, string>;
  info: Record<InfoField, string>;
  specField: Record<'description' | 'instructions' | 'identifier' | 'ifcVersions' | 'ifcVersionRaw' | 'minOccurs' | 'maxOccurs' | 'applicabilityCardinality', string>;
  reqField: Record<'cardinalityRaw' | 'description' | 'instructions', string>;
  none: string;
  changed(what: string, from: string, to: string): string;
  set(what: string, to: string): string;
  removedValue(what: string, from: string): string;
  specAdded(name: string): string;
  specRemoved(name: string): string;
  specMoved(name: string, from: number, to: number): string;
  specRenamed(from: string, to: string): string;
  specCardinality(name: string, from: string, to: string): string;
  facetAdded(section: string, text: string): string;
  facetRemoved(section: string, text: string): string;
  facetMoved(text: string, from: string, to: string): string;
  facetReplaced(from: string, to: string): string;
  position(n: number): string;
  inSpec(spec: string, section: string): string;
  psetDeclared(name: string): string;
  psetRemoved(name: string): string;
  udtDeclared(entity: string, value: string): string;
  udtRemoved(entity: string, value: string): string;
  relation: string;
}

const en: ChangelogCatalogue = {
  section: { applicability: 'applicability', requirements: 'requirement' },
  optionality: { required: 'required', optional: 'optional', prohibited: 'prohibited' },
  cardinality: { required: 'required', optional: 'optional', prohibited: 'prohibited' },
  info: { title: 'Title', copyright: 'Copyright', version: 'Version', description: 'Description', author: 'Author', date: 'Date', purpose: 'Purpose', milestone: 'Milestone' },
  specField: { description: 'description', instructions: 'instructions', identifier: 'identifier', ifcVersions: 'IFC versions', ifcVersionRaw: 'IFC version text', minOccurs: 'minimum occurrences', maxOccurs: 'maximum occurrences', applicabilityCardinality: 'applicability cardinality' },
  reqField: { cardinalityRaw: 'cardinality', description: 'description', instructions: 'instructions' },
  none: 'none',
  changed: (w, f, t) => `${w} changed from ${f} to ${t}`,
  set: (w, t) => `${w} set to ${t}`,
  removedValue: (w, f) => `${w} removed (was ${f})`,
  specAdded: (n) => `Specification "${n}" added`,
  specRemoved: (n) => `Specification "${n}" removed`,
  specMoved: (n, f, t) => `Specification "${n}" moved from position ${f} to ${t}`,
  specRenamed: (f, t) => `Specification "${f}" renamed to "${t}"`,
  specCardinality: (n, f, t) => `Specification "${n}" changed from ${f} to ${t}`,
  facetAdded: (s, t) => `${s} added: ${t}`,
  facetRemoved: (s, t) => `${s} removed: ${t}`,
  facetMoved: (t, f, to) => `"${t}" moved from ${f} to ${to}`,
  facetReplaced: (f, t) => `"${f}" replaced by "${t}"`,
  position: (n) => `position ${n}`,
  inSpec: (s, sec) => `${sec} of "${s}"`,
  psetDeclared: (n) => `Custom property set ${n} declared`,
  psetRemoved: (n) => `Custom property set ${n} no longer declared`,
  udtDeclared: (e, v) => `User-defined type ${v} declared for ${e}`,
  udtRemoved: (e, v) => `User-defined type ${v} no longer declared for ${e}`,
  relation: 'relation',
};

const de: ChangelogCatalogue = {
  section: { applicability: 'Anwendbarkeit', requirements: 'Anforderung' },
  optionality: { required: 'erforderlich', optional: 'optional', prohibited: 'verboten' },
  cardinality: { required: 'erforderlich', optional: 'optional', prohibited: 'verboten' },
  info: { title: 'Titel', copyright: 'Copyright', version: 'Version', description: 'Beschreibung', author: 'Autor', date: 'Datum', purpose: 'Zweck', milestone: 'Meilenstein' },
  specField: { description: 'Beschreibung', instructions: 'Anweisungen', identifier: 'Kennung', ifcVersions: 'IFC-Versionen', ifcVersionRaw: 'IFC-Versionstext', minOccurs: 'Mindestanzahl', maxOccurs: 'Höchstanzahl', applicabilityCardinality: 'Kardinalität der Anwendbarkeit' },
  reqField: { cardinalityRaw: 'Kardinalität', description: 'Beschreibung', instructions: 'Anweisungen' },
  none: 'keine',
  changed: (w, f, t) => `${w} geändert von ${f} zu ${t}`,
  set: (w, t) => `${w} gesetzt auf ${t}`,
  removedValue: (w, f) => `${w} entfernt (war ${f})`,
  specAdded: (n) => `Spezifikation „${n}“ hinzugefügt`,
  specRemoved: (n) => `Spezifikation „${n}“ entfernt`,
  specMoved: (n, f, t) => `Spezifikation „${n}“ von Position ${f} nach ${t} verschoben`,
  specRenamed: (f, t) => `Spezifikation „${f}“ umbenannt in „${t}“`,
  specCardinality: (n, f, t) => `Spezifikation „${n}“ geändert von ${f} zu ${t}`,
  facetAdded: (s, t) => `${s} hinzugefügt: ${t}`,
  facetRemoved: (s, t) => `${s} entfernt: ${t}`,
  facetMoved: (t, f, to) => `„${t}“ verschoben von ${f} nach ${to}`,
  facetReplaced: (f, t) => `„${f}“ ersetzt durch „${t}“`,
  position: (n) => `Position ${n}`,
  inSpec: (s, sec) => `${sec} von „${s}“`,
  psetDeclared: (n) => `Eigenes Merkmalset ${n} deklariert`,
  psetRemoved: (n) => `Eigenes Merkmalset ${n} nicht mehr deklariert`,
  udtDeclared: (e, v) => `Benutzerdefinierter Typ ${v} für ${e} deklariert`,
  udtRemoved: (e, v) => `Benutzerdefinierter Typ ${v} für ${e} nicht mehr deklariert`,
  relation: 'Beziehung',
};

const fr: ChangelogCatalogue = {
  section: { applicability: 'applicabilité', requirements: 'exigence' },
  optionality: { required: 'obligatoire', optional: 'facultatif', prohibited: 'interdit' },
  cardinality: { required: 'obligatoire', optional: 'facultative', prohibited: 'interdite' },
  info: { title: 'Titre', copyright: 'Copyright', version: 'Version', description: 'Description', author: 'Auteur', date: 'Date', purpose: 'Objet', milestone: 'Jalon' },
  specField: { description: 'description', instructions: 'instructions', identifier: 'identifiant', ifcVersions: 'versions IFC', ifcVersionRaw: 'texte de version IFC', minOccurs: 'occurrences minimales', maxOccurs: 'occurrences maximales', applicabilityCardinality: "cardinalité d'applicabilité" },
  reqField: { cardinalityRaw: 'cardinalité', description: 'description', instructions: 'instructions' },
  none: 'aucune',
  changed: (w, f, t) => `${w} modifié de ${f} à ${t}`,
  set: (w, t) => `${w} défini à ${t}`,
  removedValue: (w, f) => `${w} supprimé (était ${f})`,
  specAdded: (n) => `Spécification « ${n} » ajoutée`,
  specRemoved: (n) => `Spécification « ${n} » supprimée`,
  specMoved: (n, f, t) => `Spécification « ${n} » déplacée de la position ${f} à ${t}`,
  specRenamed: (f, t) => `Spécification « ${f} » renommée en « ${t} »`,
  specCardinality: (n, f, t) => `Spécification « ${n} » passée de ${f} à ${t}`,
  facetAdded: (s, t) => `${s} ajoutée : ${t}`,
  facetRemoved: (s, t) => `${s} supprimée : ${t}`,
  facetMoved: (t, f, to) => `« ${t} » déplacé de ${f} à ${to}`,
  facetReplaced: (f, t) => `« ${f} » remplacé par « ${t} »`,
  position: (n) => `la position ${n}`,
  inSpec: (s, sec) => `${sec} de « ${s} »`,
  psetDeclared: (n) => `Jeu de propriétés personnalisé ${n} déclaré`,
  psetRemoved: (n) => `Jeu de propriétés personnalisé ${n} n'est plus déclaré`,
  udtDeclared: (e, v) => `Type défini par l'utilisateur ${v} déclaré pour ${e}`,
  udtRemoved: (e, v) => `Type défini par l'utilisateur ${v} n'est plus déclaré pour ${e}`,
  relation: 'relation',
};

const CATALOGUES: Record<SupportedLocale, ChangelogCatalogue> = { en, de, fr };

export function catalogue(locale: SupportedLocale): ChangelogCatalogue {
  return CATALOGUES[locale] ?? en;
}
