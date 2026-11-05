# Viewer localization

English is the fallback. Feature messages live in `catalogues/*.en.ts`, composed
in `en.ts`; some register with their lazy feature. Italian, French, German and Russian ship as
`locales/it.ts`, `locales/fr.ts`, `locales/de.ts` and `locales/ru.ts`, each composing bounded feature modules in its
sibling folder. Do not replace the locale registry or add a second loading path.

## Selecting a language

Use `?lang=it`, `?lang=fr` or `?lang=de` (or `?lang=en` to switch back). The URL selection is remembered in
`localStorage` under `ifc-lite:locale`. Without a URL choice, startup uses the
remembered locale, then browser languages (`de-CH` matches `de`), then English.
`<html lang>` follows the active locale. `locales.boot.ts` discovers locale entry
files as lazy chunks; a new locale needs no viewer wiring.

## Updating messages

Add or change English, Italian, French and German together, including lazy feature messages.
Keep complete messages, every named placeholder, plural forms with `other`, and
all exact IFC EXPRESS identifiers. Never translate user-supplied names or values;
interpolate them. Use the existing Intl helpers for numbers, input parsing,
dates and lists; count messages select forms through Intl.PluralRules.

Run root `pnpm typecheck` and `pnpm test` through Turbo and machine admission.
`german-catalogue.test.ts` loads every English feature object (including lazy
ones), requires exact German key coverage, rejects empty messages except the intentional dimensionless `modelingCommand.unit.count` suffix and invokes
the existing placeholder validator. `catalogue-problems.test.ts` also validates
all contributed locale entries. Update the explicit German technical-copy
exceptions when a new intentionally identical technical label is necessary;
do not exempt arbitrary capitalized words. Coverage is for catalogued messages,
not a claim that every legacy toast, template, extension label or runtime
message is translated. The existing `check-i18n-literals.mjs` ratchet guards the
tracked JSX surface; do not sweep unrelated strings as part of a locale update.

## German glossary and style

- Storey: **Geschoss**; model element/product: **Bauteil**.
- Properties: **Eigenschaften**; quantity: **Menge** (or the named physical
  Größe, Fläche, Länge, Volumen where appropriate).
- Clash: **Kollision**; section: **Schnitt**, cutting plane: **Schnittebene**;
  measurement: **Messung**.
- Use concise German labels and complete warnings. Preserve negation,
  reversibility and destructive-action consequences. Keep technical/product
  names, schema attributes and shortcut glyphs exact. Model content remains
  untouched even when it happens to be English.

## New locale or feature

No viewer code changes. `locales.boot.ts` discovers the file as a lazy chunk,
and it appears in Settings → General → Language under its own name. The viewer
uses the choice made there (remembered in `localStorage` under
`ifc-lite:locale`; "Auto" forgets it), then the browser's languages (`de-CH`
matches `de`), then English. Switching applies without a reload, and
`<html lang>` follows the active locale. There is no URL parameter for the
language.

Default-export a `Catalogue` from `locales/<BCP-47-tag>.ts`; feature files import
that type from `../../registry`. A partial new locale falls back key by key,
but shipping Italian, French and German is required to remain complete. New source files need the
MPL header and bounded modules. For a lazy English feature, add its key type and
placeholder metadata to the existing lazy catalogue mechanism and register the
English catalogue before the feature renders. Test actual runtime resolution;
never assert on source file text.

## French glossary and maintenance

Use étage for storey, élément for model element/product, propriétés, quantités,
collision, coupe / plan de coupe and mesure. Niveau denotes a generic level.
Preserve exact IFC EXPRESS identifiers and author-supplied model values.
French uses Intl cardinal one (including zero and some fractions), other and
many (million multiples). Keep placeholders in every selected form; many can
share the ordinary plural wording. Do not copy English as completion.

`french-catalogue.test.ts` loads every eager/lazy English object and checks full
coverage, value-pinned identical exceptions and plural runtime composition.
`french-startup.test.ts` checks lazy messages before English feature registration.
Maintain `locales/fr-identical.json` only for reviewed truly shared words,
schema/product symbols and units, with exact value and reason. URL `?lang=fr`
persists normally; browser `fr-CH` negotiates to French and updates HTML lang.
Acceptance, bounded round ledger and runtime evidence: `tools/localization-french/`.

## Italian glossary and maintenance

Use piano for storey, elemento for model product, proprietà, quantità,
interferenza, sezione / piano di sezione and misura. Livello denotes a generic
level. Preserve exact IFC EXPRESS names, technical tokens and model content.
Warnings retain the action, condition, negation and consequence; Annulla reverses
edits already applied. Italian Intl cardinal categories are one, other and many;
decimals select other, and million multiples select many. Keep exact placeholders
in each branch, using the corresponding English branch or other as the contract.

`italian-catalogue.test.ts` checks every eager/lazy key, placeholder branches and
value-pinned identical exceptions in `locales/it-identical.json`.
`italian-startup.test.ts` checks ownership before lazy English registration;
`italian-ids.test.tsx` checks IDS synchronization. URL `?lang=it` persists;
browser `it-CH` negotiates to Italian and updates HTML lang.
The acceptance checklist, bounded round ledger and actual validation evidence
live in `tools/localization-italian/`. Runtime model names remain unmodified.

## Release contracts and rollback

The locale catalogue/startup tests share test-only helpers under `test-support/`.
They compare loaded objects against every current English feature, enforce exact
value-pinned identical-word exceptions, and exercise runtime resolution. Browser
acceptance shares `tools/localization-shared/workflow-verdict.mjs`: all ten unique
checks must pass; inspection, skips and page errors cannot produce acceptance.
These helpers are not imported by the production viewer.

Rollback a faulty locale with a normal commit removing its entry file
`locales/<tag>.ts` and its locale-specific tests (retain the bounded translations
for repair). `locales.boot.ts` discovers entry files automatically, so URL, saved
choice and browser negotiation all use the same remaining loader set and fall
back to English. Validate the negotiation tests and root graph before merging;
restore the entry and tests in a later normal commit. Do not rewind production.
