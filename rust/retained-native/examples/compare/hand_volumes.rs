// SPDX-License-Identifier: MPL-2.0
//! Preregistered closed-form authorities; unused rows of a compared fixture are errors.
use serde::{Deserialize, Deserializer, de::{self, MapAccess, Visitor}};
use std::{collections::{BTreeMap, BTreeSet}, fmt};
pub const REGISTERED: &str = include_str!("../../../../tests/fixtures/cli-retained/m6-hand-volumes.json");
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { volume: f64, derivation: String }
// serde's ordinary maps silently overwrite duplicate keys. Authorities must not.
struct Unique<T>(BTreeMap<String, T>);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Unique<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct MapVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for MapVisitor<T> {
            type Value = Unique<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("unique-key object") }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut map = BTreeMap::new();
                while let Some((key, value)) = a.next_entry::<String, T>()? {
                    if map.insert(key.clone(), value).is_some() {
                        return Err(de::Error::custom(format!("duplicate hand-volume key {key}")));
                    }
                }
                Ok(Unique(map))
            }
        }
        d.deserialize_map(MapVisitor(std::marker::PhantomData))
    }
}
pub struct HandVolumes { remaining: BTreeMap<(String, u32), f64>, visited: BTreeSet<String> }
impl HandVolumes {
    pub fn parse(text: &str) -> Result<Self, String> {
        let rows: Unique<Unique<Entry>> = serde_json::from_str(text).map_err(|e| format!("malformed hand volumes: {e}"))?;
        let mut remaining = BTreeMap::new();
        for (path, products) in rows.0 {
            if !path.starts_with("tests/fixtures/synthetic-retained/") || !path.ends_with(".ifc")
                || path.split('/').any(|p| p == ".." || p == "." || p.is_empty()) || products.0.is_empty() {
                return Err(format!("invalid hand-volume fixture {path}"));
            }
            for (key, entry) in products.0 {
                let id: u32 = key.parse().map_err(|_| format!("invalid hand-volume product {key}"))?;
                if id == 0 || id.to_string() != key || !entry.volume.is_finite() || entry.volume <= 0.
                    || entry.derivation.trim().is_empty() {
                    return Err(format!("invalid hand-volume entry {path}:{key}"));
                }
                remaining.insert((path.clone(), id), entry.volume);
            }
        }
        Ok(Self { remaining, visited: BTreeSet::new() })
    }
    /// Marks a fixture as compared, so its unused rows are stale at `finish`.
    pub fn visit(&mut self, path: &str) { self.visited.insert(path.to_owned()); }
    pub fn take(&mut self, path: &str, id: u32) -> Option<f64> {
        self.visit(path);
        self.remaining.remove(&(path.to_owned(), id))
    }
    /// Rows of fixtures outside this run's universe (a `--manifest` corpus run)
    /// are not stale; rows of a compared fixture that no product consumed are.
    pub fn finish(&self) -> Result<(), String> {
        let stale = self.remaining.keys().filter(|(path, _)| self.visited.contains(path)).collect::<Vec<_>>();
        if stale.is_empty() { Ok(()) }
        else { Err(format!("stale/unseen hand-volume rows: {stale:?}")) }
    }
}
