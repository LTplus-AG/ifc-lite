// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`ResultCacheConfig`], its mode, its test hooks and the default location.

use std::path::PathBuf;

/// What a [`ResultCache`](super::ResultCache) may do. Off unless a caller opts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheMode {
    /// Call [`process`](crate::process) directly; no hashing, no file access.
    #[default]
    Off,
    /// Replay entries; never create, write or touch anything.
    ReadOnly,
    /// Replay entries; store new results; refresh last-use times; evict.
    ReadWrite,
}

/// Where and how much. Defaults: off, the platform cache directory, 10 GiB
/// per directory, 1 GiB per entry. The limits are policy choices, not
/// measured optima.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct ResultCacheConfig {
    pub mode: CacheMode,
    /// `None`: [`default_directory`]. Entries go in a `result-v1` directory
    /// beneath it.
    pub directory: Option<PathBuf>,
    pub max_bytes: u64,
    pub max_entry_bytes: u64,
    /// Test hook: mixed into the engine identity to stand for a different
    /// build or entry format. Empty in production.
    #[doc(hidden)]
    pub engine_salt: Vec<u8>,
    /// Test hook: called with the batch number after each live batch, so a
    /// test can act deterministically in the middle of a pass. `None` in
    /// production; the cached pass then runs with no sink at all.
    #[doc(hidden)]
    pub pass_hook: Option<PassHook>,
}

/// See [`ResultCacheConfig::pass_hook`].
#[doc(hidden)]
#[derive(Clone)]
pub struct PassHook(pub std::sync::Arc<dyn Fn(usize) + Send + Sync>);

impl std::fmt::Debug for PassHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PassHook")
    }
}

/// Calls the [`PassHook`] after each batch; no other event.
pub(super) struct HookSink<'a>(pub(super) &'a PassHook, pub(super) usize);

impl crate::ProcessingSink for HookSink<'_> {
    fn on_batch(&mut self, _meshes: &[crate::MeshData], _processed: usize, _total: usize) {
        self.1 += 1;
        (self.0 .0)(self.1);
    }
}

impl Default for ResultCacheConfig {
    fn default() -> Self {
        Self {
            mode: CacheMode::Off,
            directory: None,
            max_bytes: 10 << 30,
            max_entry_bytes: 1 << 30,
            engine_salt: Vec::new(),
            pass_hook: None,
        }
    }
}

impl ResultCacheConfig {
    pub fn mode(mut self, mode: CacheMode) -> Self {
        self.mode = mode;
        self
    }
    pub fn directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.directory = Some(directory.into());
        self
    }
    pub fn max_bytes(mut self, bytes: u64) -> Self {
        self.max_bytes = bytes;
        self
    }
    pub fn max_entry_bytes(mut self, bytes: u64) -> Self {
        self.max_entry_bytes = bytes;
        self
    }
    #[doc(hidden)]
    pub fn engine_salt(mut self, salt: &[u8]) -> Self {
        self.engine_salt = salt.to_vec();
        self
    }
    #[doc(hidden)]
    pub fn pass_hook(mut self, hook: impl Fn(usize) + Send + Sync + 'static) -> Self {
        self.pass_hook = Some(PassHook(std::sync::Arc::new(hook)));
        self
    }
}

/// The per-user default root: `IFC_LITE_CACHE_DIR` if set, else
/// `$XDG_CACHE_HOME/ifc-lite/native` or `~/.cache/ifc-lite/native` (Linux and
/// other Unix), `~/Library/Caches/ifc-lite/native` (macOS),
/// `%LOCALAPPDATA%\ifc-lite\native` (Windows).
pub fn default_directory() -> Option<PathBuf> {
    let env_dir = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = env_dir("IFC_LITE_CACHE_DIR") {
        return Some(dir);
    }
    let base = if cfg!(windows) {
        env_dir("LOCALAPPDATA")
    } else if cfg!(target_os = "macos") {
        env_dir("HOME").map(|h| h.join("Library").join("Caches"))
    } else {
        env_dir("XDG_CACHE_HOME").filter(|p| p.is_absolute()).or_else(|| env_dir("HOME").map(|h| h.join(".cache")))
    };
    base.map(|b| b.join("ifc-lite").join("native"))
}

