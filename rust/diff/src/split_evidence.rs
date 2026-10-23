// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Volume evidence for additive split/merge claims (#8042).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeKind { Confirmed, Refuted, Unknown }

#[derive(Debug, Clone, PartialEq)]
pub struct VolumeVerdict {
    pub kind: VolumeKind,
    pub complete: bool,
    pub whole_volume: Option<f64>,
    pub pieces_volume: Option<f64>,
    pub residual: Option<f64>,
}

pub fn usable_volume(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

pub fn judge_volumes(whole_raw: Option<f64>, pieces: &[Option<f64>], tolerance: f64) -> VolumeVerdict {
    let whole = usable_volume(whole_raw);
    let mut known = 0;
    let mut sum = 0.0;
    for raw in pieces {
        if let Some(volume) = usable_volume(*raw) {
            known += 1;
            sum += volume;
        }
    }
    let complete = whole.is_some() && known == pieces.len();
    let Some(whole) = whole else {
        return VolumeVerdict { kind: VolumeKind::Unknown, complete: false,
            whole_volume: None, pieces_volume: None, residual: None };
    };
    let band = tolerance * whole;
    if sum > whole + band {
        return VolumeVerdict { kind: VolumeKind::Refuted, complete,
            whole_volume: Some(whole), pieces_volume: Some(sum), residual: Some((sum - whole) / whole) };
    }
    if !complete {
        return VolumeVerdict { kind: VolumeKind::Unknown, complete: false,
            whole_volume: Some(whole), pieces_volume: None, residual: None };
    }
    VolumeVerdict {
        kind: if (sum - whole).abs() <= band { VolumeKind::Confirmed } else { VolumeKind::Refuted },
        complete: true, whole_volume: Some(whole), pieces_volume: Some(sum),
        residual: Some((sum - whole) / whole),
    }
}

/// Remove at most one uniquely identifiable overshoot; never search subsets.
pub fn find_single_interloper(whole: f64, pieces: &[f64], tolerance: f64) -> Option<usize> {
    // Keep the JavaScript left-to-right addition order, including rounding.
    let sum = pieces.iter().fold(0.0, |sum, volume| sum + volume);
    let overshoot = sum - whole;
    let band = tolerance * whole;
    if overshoot <= band || pieces.len() < 3 { return None; }
    let mut found = None;
    for (index, volume) in pieces.iter().enumerate() {
        if (volume - overshoot).abs() > band { continue; }
        if found.is_some() { return None; }
        found = Some(index);
    }
    found
}

#[cfg(test)]
#[path = "split_evidence_tests.rs"]
mod tests;
