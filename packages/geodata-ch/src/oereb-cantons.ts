/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-canton ÖREB (PLR cadastre) web service base URLs: the FALLBACK when
 * the federal availability layer `ch.swisstopo-vd.stand-oerebkataster`
 * has no record for a parcel. The register is consulted first because it
 * tracks moves; this table is a snapshot.
 *
 * How each entry was verified (2026-11-15): the register was queried at a
 * point in the canton's capital, the base was taken from its
 * `oereb_extract_url` (NOT its `oereb_webservice` field, which was wrong
 * for GL, ZG, SH and JU: a 404 path, a full extract URL, a 404 path and a
 * 500 path respectively), and `GET {base}/versions/{json|xml}` (ÖREB v2
 * spec) had to answer 200 (SO and SH: only `/versions/xml` did; their entries
 * record the 500 for json). Every URL in swiss-zoning-api's older table that
 * differs from these is stale.
 */

export interface CantonOerebService {
  /** Two-letter canton code. */
  canton: string;
  /** The canton's name as the federal register spells it (`kanton`). */
  registerName: string;
  base: string;
  verification: 'verified' | 'unverified';
  /** ISO date of the check. */
  checkedOn: string;
  note?: string;
}

const D = '2026-11-15';

function v(canton: string, registerName: string, base: string, note?: string): CantonOerebService {
  return { canton, registerName, base, verification: 'verified', checkedOn: D, ...(note ? { note } : {}) };
}

export const CANTON_OEREB_SERVICES: readonly CantonOerebService[] = [
  v('ZH', 'Zürich', 'https://maps.zh.ch/oereb/v2'),
  v('BE', 'Bern', 'https://www.oereb2.apps.be.ch'),
  v('LU', 'Luzern', 'https://svc.geo.lu.ch/oereb'),
  v('UR', 'Uri', 'https://prozessor-oereb.ur.ch/oereb'),
  v('SZ', 'Schwyz', 'https://map.geo.sz.ch/oereb'),
  v('OW', 'Obwalden', 'https://www.gis-daten.ch/oereb', 'Shared service with NW'),
  v('NW', 'Nidwalden', 'https://www.gis-daten.ch/oereb', 'Shared service with OW'),
  v('GL', 'Glarus', 'https://map.geo.gl.ch/oereb'),
  v('ZG', 'Zug', 'https://oereb.zg.ch/ors'),
  v('FR', 'Fribourg', 'https://maps.fr.ch/RDPPF_ws/RdppfSVC.svc'),
  v('SO', 'Solothurn', 'https://geo.so.ch/api/oereb', '/versions/json answered 500, /versions/xml 200'),
  v('BS', 'Basel-Stadt', 'https://api.oereb.bs.ch'),
  v('BL', 'Basel-Landschaft', 'https://oereb.geo.bl.ch'),
  v('SH', 'Schaffhausen', 'https://oereb.geo.sh.ch', '/versions/json answered 500, /versions/xml 200'),
  v('AR', 'Appenzell Ausserrhoden', 'https://oereb.ar.ch/ktar/wsgi/oereb'),
  v('AI', 'Appenzell Innerrhoden', 'https://oereb.ai.ch/ktai/wsgi/oereb'),
  v('SG', 'St. Gallen', 'https://oereb.geo.sg.ch/ktsg/wsgi/oereb'),
  v('GR', 'Graubünden', 'https://oereb.geo.gr.ch/oereb'),
  v('AG', 'Aargau', 'https://api.geo.ag.ch/v2/oereb'),
  v('TG', 'Thurgau', 'https://map.geo.tg.ch/services/oereb'),
  v('TI', 'Ticino', 'https://crdpp.geo.ti.ch/oereb2'),
  v('VD', 'Vaud', 'https://www.rdppf.vd.ch/ws/RdppfSVC.svc'),
  {
    canton: 'VS',
    registerName: 'Valais',
    base: 'https://rdppf.apps.vs.ch',
    verification: 'unverified',
    checkedOn: D,
    note: 'Listed by the federal register, but /versions timed out after 40 s from the checking host',
  },
  v('NE', 'Neuchâtel', 'https://sitn.ne.ch/crdppf'),
  v('GE', 'Genève', 'https://ge.ch/terecadastrews/RdppfSVC.svc'),
  v('JU', 'Jura', 'https://geo.jura.ch/crdppf_server'),
];

export function cantonOerebService(cantonCodeOrName: string): CantonOerebService | undefined {
  const k = cantonCodeOrName.trim();
  return CANTON_OEREB_SERVICES.find((s) => s.canton === k.toUpperCase() || s.registerName === k);
}
