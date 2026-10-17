// SPDX-License-Identifier: MPL-2.0
use super::*;

#[test]
fn fnv1a64_known_vectors() {
    assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a64(b"hello"), 0xa430_d846_80aa_bd0b);
}

#[test]
fn fnv1a32_matches_the_js_fingerprint_vectors() {
    assert_eq!(fnv1a32(b""), 0x811c_9dc5);
    assert_eq!(fnv1a32(b"hello"), 0x4f9f_2cab);
}

#[test]
fn streaming_equals_one_shot_and_mix_word_is_not_bytewise() {
    let mut h = Fnv1a64::new();
    h.write(b"hel").write(b"lo");
    assert_eq!(h.finish(), fnv1a64(b"hello"));
    let mut w = Fnv1a64::new();
    w.mix_word(7);
    assert_ne!(w.finish(), Fnv1a64::new().write(&7u64.to_le_bytes()).finish());
    assert_eq!(w.finish(), (FNV64_OFFSET ^ 7).wrapping_mul(FNV64_PRIME));
}

#[test]
fn content_hash_frames_runs_so_they_cannot_alias() {
    let a = ContentHash::new().write_f32s(&[1.0]).write_f32s(&[]).finish();
    let b = ContentHash::new().write_f32s(&[]).write_f32s(&[1.0]).finish();
    assert_ne!(a, b);
    let c = ContentHash::new().write_f32s(&[0.0]).finish();
    let d = ContentHash::new().write_f32s(&[-0.0]).finish();
    assert_ne!(c, d, "bit patterns, not values");
    assert_eq!(
        ContentHash::new().write_u32s(&[1, 2]).finish(),
        ContentHash::new().write_u32s(&[1, 2]).finish()
    );
}
