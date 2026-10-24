// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Independently loaded diff engine; no geometry or parser dependencies.
mod diff;
mod diff_fingerprint;
mod diff_fingerprint_input;
mod diff_sidecar;
mod diff_lineage;
mod diff_provenance;
mod diff_normalize;
mod diff_transport;
mod diff_sidecar_host;
mod diff_sidecar_observe;
mod diff_sidecar_lineage;
mod diff_sidecar_create;
mod diff_sidecar_public;
