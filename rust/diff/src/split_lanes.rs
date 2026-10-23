// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::model::{EntityAabb, EntityFingerprint};
use crate::split_types::*;
use crate::split_geometry::*;
use crate::split_grid::{BoxGrid, cluster_by_proximity};
use crate::split_evidence::*;
fn bbox<R>(entity: &EntityFingerprint<R>) -> &EntityAabb {
    entity.aabb.as_ref().expect("split candidate has a usable box")
}
pub(crate) fn in_place<'a, R>(wholes: &[&'a EntityFingerprint<R>], pieces: &[&'a EntityFingerprint<R>],
    kind: SplitMergeKind, settings: SplitSettings) -> Vec<SplitMergeClaim<'a, R>> {
    if wholes.is_empty() || pieces.len() < 2 { return vec![]; }
    let boxes: Vec<_> = pieces.iter().map(|p| bbox(p).clone()).collect();
    let grid = BoxGrid::new(&boxes);
    let mut claims = vec![];
    for &whole in wholes {
        let pad = containment_padding(bbox(whole), settings.padding_min, settings.padding_ratio);
        let contained: Vec<_> = grid.query(bbox(whole), pad).into_iter().map(|i| pieces[i])
            .filter(|p| box_within(bbox(p), bbox(whole), pad)).collect();
        if contained.len() < 2 || contained.len() as f64 > settings.max_pieces { continue; }
        let volumes: Vec<_> = contained.iter().map(|p| p.volume).collect();
        let verdict = judge_volumes(whole.volume, &volumes, settings.volume_tolerance);
        let mut kept = contained;
        let mut excluded = None;
        let mut final_verdict = verdict;
        if final_verdict.kind == VolumeKind::Refuted {
            if !final_verdict.complete { continue; }
            let raw: Vec<_> = volumes.iter().map(|v| usable_volume(*v).unwrap()).collect();
            let Some(index) = find_single_interloper(final_verdict.whole_volume.unwrap(), &raw, settings.volume_tolerance) else { continue; };
            excluded = Some(kept.remove(index));
            let remaining: Vec<_> = kept.iter().map(|p| p.volume).collect();
            final_verdict = judge_volumes(whole.volume, &remaining, settings.volume_tolerance);
            if final_verdict.kind != VolumeKind::Confirmed { continue; }
        }
        if final_verdict.kind == VolumeKind::Confirmed {
            claims.push(claim_of(kind, SplitConfidence::Verified, whole, kept,
                Some((final_verdict.whole_volume.unwrap(), final_verdict.pieces_volume.unwrap(), final_verdict.residual.unwrap())), excluded));
        } else {
            let boxes: Vec<_> = kept.iter().map(|p| bbox(p).clone()).collect();
            if any_coincident(&boxes, 0.5) || !extent_coverage(bbox(whole), &boxes, pad) { continue; }
            claims.push(claim_of(kind, SplitConfidence::Extent, whole, kept, None, None));
        }
    }
    claims
}
struct Cluster<'a, R> { members: Vec<&'a EntityFingerprint<R>>, volume: f64, bbox: EntityAabb, extents: [f64; 3] }
pub(crate) fn displaced<'a, R>(wholes: &[&'a EntityFingerprint<R>], pieces: &[&'a EntityFingerprint<R>],
    kind: SplitMergeKind, settings: SplitSettings) -> Vec<SplitMergeClaim<'a, R>> {
    if wholes.is_empty() || pieces.len() < 2 { return vec![]; }
    let boxes: Vec<_> = pieces.iter().map(|p| bbox(p).clone()).collect();
    let pads: Vec<_> = boxes.iter().map(|b| containment_padding(b, settings.padding_min, settings.padding_ratio)).collect();
    let mut clusters = vec![];
    for component in cluster_by_proximity(&boxes, &pads) {
        if component.len() < 2 || component.len() as f64 > settings.max_pieces { continue; }
        let members: Vec<_> = component.iter().map(|&i| pieces[i]).collect();
        let Some(volumes) = members.iter().map(|m| usable_volume(m.volume)).collect::<Option<Vec<_>>>() else { continue; };
        let volume = volumes.iter().fold(0.0, |sum, v| sum + v);
        let cluster_box = box_union(&members.iter().map(|p| bbox(p).clone()).collect::<Vec<_>>());
        let extents = sorted_extents(&cluster_box);
        clusters.push(Cluster { members, volume, bbox: cluster_box, extents });
    }
    let mut sorted: Vec<_> = wholes.iter().filter_map(|&w| usable_volume(w.volume).map(|v| (w, v))).collect();
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let mut matches_per_cluster = vec![];
    let mut clusters_per_whole = vec![0usize; sorted.len()];
    for cluster in &clusters {
        let lo = cluster.volume / (1.0 + settings.volume_tolerance);
        let hi = if settings.volume_tolerance < 1.0 { cluster.volume / (1.0 - settings.volume_tolerance) } else { f64::INFINITY };
        let mut matches = vec![];
        let start = sorted.partition_point(|(_, v)| *v < lo);
        for (i, &(whole, volume)) in sorted.iter().enumerate().skip(start) {
            if volume > hi { break; }
            let extents = sorted_extents(bbox(whole));
            let congruent = (0..3).all(|a| (cluster.extents[a] - extents[a]).abs() <= settings.padding_min.max(settings.volume_tolerance * cluster.extents[a].max(extents[a])));
            if !congruent { continue; }
            let pad = containment_padding(bbox(whole), settings.padding_min, settings.padding_ratio);
            if box_within(&cluster.bbox, bbox(whole), pad) { continue; }
            matches.push(i);
            clusters_per_whole[i] += 1;
        }
        matches_per_cluster.push(matches);
    }
    let mut claims = vec![];
    for (cluster, matches) in clusters.into_iter().zip(matches_per_cluster) {
        if matches.len() != 1 || clusters_per_whole[matches[0]] != 1 { continue; }
        let (whole, volume) = sorted[matches[0]];
        claims.push(claim_of(kind, SplitConfidence::Displaced, whole, cluster.members,
            Some((volume, cluster.volume, (cluster.volume - volume) / volume)), None));
    }
    claims
}
