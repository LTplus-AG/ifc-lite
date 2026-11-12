/** #9296: a narrower duplicate must not mask a failure. */
export function validateRegistry(probes) {
  for (const key of ['id', 'capability']) {
    const seen = new Set();
    for (const probe of probes) {
      if (!probe[key] || seen.has(probe[key])) throw new Error(`Duplicate or missing probe ${key}: ${probe[key]}`);
      seen.add(probe[key]);
    }
  }
  return probes;
}
