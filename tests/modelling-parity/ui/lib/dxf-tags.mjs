/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

function dxfLabels(download) {
  if (!download) return [];
  // The real R12 download declares ANSI_1252. Walk group-code/value pairs;
  // a numeric value of zero is not an entity boundary.
  const lines = new TextDecoder('windows-1252').decode(download.bytes).replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);
  // Only drawn entities count: TEXT inside BLOCKS (or any other section) is
  // not on the sheet unless inserted, so it must not certify a tag.
  const labels = []; let current = null, section = null, sectionOpen = false;
  for (let i=0; i+1<lines.length; i+=2) {
    const code = Number(lines[i].trim()), value = lines[i+1];
    if (!Number.isInteger(code)) return [];
    if (code === 0) {
      if (current) labels.push(current);
      sectionOpen = value === 'SECTION';
      if (value === 'ENDSEC') section = null;
      current = section === 'ENTITIES' && (value === 'TEXT' || value === 'MTEXT') ? { type: value, layer: '', text: '' } : null;
    } else if (sectionOpen && code === 2) { section = value.trim(); sectionOpen = false; }
    else if (current && code === 8) current.layer = value;
    else if (current && (code === 1 || code === 3)) current.text += value;
  }
  if (current) labels.push(current);
  return labels;
}

// This row checks tag identity and quantity, not Unicode encoding fidelity.
// The product emits ≈ (U+2248), but its R12 cp1252 encoder replaces it with ?.
// Keep that known loss explicit; do not accept arbitrary room-label prefixes.
export function dxfTagTextsMatch(download, door, space, area) {
  if (!door || !space || !Number.isFinite(area)) return false;
  const tags = dxfLabels(download).filter(entity => entity.layer === 'DXF_Element_tags_IFC-TAGS');
  const rooms = ['≈', '?'].map(marker => `${space} · ${marker} ${Number(area.toFixed(2))} m²`);
  return tags.length === 2 && tags.every(entity => entity.type === 'TEXT')
    && tags.filter(entity => entity.text === door).length === 1
    && tags.filter(entity => rooms.includes(entity.text)).length === 1;
}
