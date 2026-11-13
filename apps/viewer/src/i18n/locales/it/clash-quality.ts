/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Catalogue } from '../../registry';

export const clashQualityIt = {
  'clashQuality.detectionExclusions': 'Esclusioni di rilevamento per aperture ed elementi ospitanti: {value}',
  'clashQuality.enabled': 'Attivate',
  'clashQuality.disabled': 'Disattivate',
  'clashQuality.title': 'Criteri di qualità',
  'clashQuality.configure': 'Configura i criteri di qualità',
  'clashQuality.clash': 'Controlli delle interferenze',
  'clashQuality.duplicates': 'Controlli dei duplicati',
  'clashQuality.minimum': 'Percentuale minima di oggetti senza anomalie',
  'clashQuality.label': 'Nome della categoria',
  'clashQuality.color': 'Colore della categoria',
  'clashQuality.newCategory': 'Nuova categoria',
  'clashQuality.add': 'Aggiungi categoria',
  'clashQuality.remove': 'Rimuovi categoria',
  'clashQuality.save': 'Salva soglie',
  'clashQuality.saved': 'Soglie dei criteri di qualità salvate',
  'clashQuality.failed': 'Impossibile salvare le soglie dei criteri di qualità',
  'clashQuality.invalid': 'Inizia da 0 %, usa valori minimi crescenti fino al 100 % e assegna un nome a ogni categoria.',
  'clashQuality.policy': 'Gli oggetti senza anomalie sono gli oggetti distinti controllati senza rilievi rilevati. Si contano entrambi gli oggetti di ogni coppia; ogni oggetto viene contato una sola volta. Le esclusioni dei risultati, lo stato di revisione e i filtri di visualizzazione non modificano questo punteggio. Restano valide le esclusioni di rilevamento per aperture ed elementi ospitanti. I controlli dei duplicati includono tutti gli oggetti coinvolti, non solo le copie in eccesso.',
  'clashQuality.counts': '{checked} controllati · {affected} coinvolti',
  'clashQuality.metric': 'Oggetti senza rilievi rilevati',
  'clashQuality.not-evaluated': 'Non valutato',
  'clashQuality.unavailable': 'Copertura del controllo non disponibile',
  'clashQuality.incomplete': 'Esecuzione incompleta',
  'clashQuality.outdated': 'Esecuzione non aggiornata',
  'clashQuality.document': 'Aggiungi i criteri di qualità alla documentazione',
  'clashQuality.documentFailed': 'Impossibile salvare il documento dei criteri di qualità',
  'clashQuality.models': 'Modelli: {models}',
  'clashQuality.tolerance': 'Tolleranza: {tolerance} m',
  'clashQuality.clearance': 'Distanza libera: {clearance} m',
  'clashQuality.captured': 'Acquisito: {when}',
  'clashQuality.revision': 'Revisione delle modifiche del modello: {revision}',
  'clashQuality.unknown': 'Sconosciuto',
} satisfies Catalogue;
