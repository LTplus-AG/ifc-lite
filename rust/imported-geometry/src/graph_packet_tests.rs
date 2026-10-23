// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

struct Packet(Vec<u8>);
impl Packet {
    fn new(kind: u32) -> Self { let mut p = Self(Vec::new()); p.word(1).word(kind); p }
    fn word(&mut self, value: u32) -> &mut Self { self.0.extend(value.to_le_bytes()); self }
    fn wide(&mut self, value: u64) -> &mut Self { self.0.extend(value.to_le_bytes()); self }
    fn double(&mut self, value: f64) -> &mut Self { self.0.extend(value.to_le_bytes()); self }
    fn string(&mut self, value: &str) -> &mut Self { self.word(value.len() as u32); self.0.extend(value.as_bytes()); self }
    fn values(&mut self, values: &[f64]) -> &mut Self {
        self.word(values.len() as u32); for value in values { self.double(*value); } self
    }
    fn run(&self) -> Result<Vec<u8>, ImportError> { dispatch(&self.0) }
}
fn open(mode: u32) -> u32 {
    let mut packet = Packet::new(100);
    packet.wide(7).wide(11).word(mode).word(1).word(1).string("实体/α").word(0);
    u32::from_le_bytes(packet.run().unwrap().try_into().unwrap())
}
fn poll(handle: u32) -> Vec<u8> { Packet::new(101).word(handle).run().unwrap() }
fn header(bytes: &[u8], expected_kind: u32) -> (Reader<'_>, u32) {
    let mut r = Reader { data: bytes, offset: 0 };
    assert_eq!(r.u32().unwrap(), expected_kind);
    let sequence = r.u32().unwrap(); assert_ne!(sequence, 0);
    assert!(r.u64().unwrap() >= 1); assert_eq!(r.u32().unwrap(), 0);
    if expected_kind != 1 { assert_eq!(r.u32().unwrap(), 0); }
    (r, sequence)
}
fn node_reply(handle: u32, sequence: u32, mesh: bool) -> Packet {
    let mut packet = Packet::new(102);
    packet.word(handle).word(sequence).word(1).word(0).word(0).word(0).double(1.).word(0)
        .word(u32::from(mesh)).word(u32::from(!mesh));
    packet
}
fn floats(r: &mut Reader<'_>) -> Vec<f32> {
    let count = r.u32().unwrap();
    (0..count).map(|_| f32::from_bits(r.u32().unwrap())).collect()
}
fn close(handle: u32) { assert!(Packet::new(107).word(handle).run().unwrap().is_empty()); }

#[test]
fn graph_packet_rejects_stale_kind_sequence_and_trailing_bytes_without_consuming_request() {
    let handle = open(1);
    let pending = poll(handle);
    let (mut r, sequence) = header(&pending, 1);
    assert_eq!(r.u32().unwrap(), 1); assert_eq!(r.u32().unwrap(), 0);
    assert!(!r.boolean().unwrap()); assert_eq!(r.offset, pending.len());
    assert_eq!(poll(handle), pending);
    assert_eq!(Packet::new(106).word(handle).word(sequence).run(), Err(ImportError::IdentityMismatch));
    assert_eq!(node_reply(handle, sequence + 1, true).run(), Err(ImportError::IdentityMismatch));
    let mut malformed = node_reply(handle, sequence, true);
    malformed.word(99);
    assert_eq!(malformed.run(), Err(ImportError::InvalidPacket));
    assert_eq!(poll(handle), pending);
    assert!(node_reply(handle, sequence, true).run().unwrap().is_empty());
    let key = poll(handle);
    let (mut r, sequence) = header(&key, 2);
    assert!(floats(&mut r).is_empty()); assert!(!r.boolean().unwrap());
    assert_eq!(r.offset, key.len());
    assert!(Packet::new(103).word(handle).word(sequence).string("实体/α|1|identity|default").run().unwrap().is_empty());
    let source = poll(handle);
    let (r, _) = header(&source, 3); assert_eq!(r.offset, source.len());
    close(handle); close(handle);
    assert_eq!(Packet::new(101).word(handle).run(), Err(ImportError::IdentityMismatch));
    let next = open(1); assert!(next > handle); close(next);
}

#[test]
fn graph_packet_real_triangle_output_and_outer_framing_match_binary_contract() {
    let handle = open(1);
    let pending = poll(handle); let (_, sequence) = header(&pending, 1);
    node_reply(handle, sequence, true).run().unwrap();
    let key = poll(handle); let (_, sequence) = header(&key, 2);
    Packet::new(103).word(handle).word(sequence).string("mesh").run().unwrap();
    let source = poll(handle); let (_, sequence) = header(&source, 3);
    let mut mesh = Packet::new(104);
    mesh.word(handle).word(sequence).word(3).values(&[0., 0., 0.]).values(&[1., 0., 0.])
        .values(&[0., 1., 0.]).values(&[0., 1., 2.]).word(0).word(0);
    assert!(mesh.run().unwrap().is_empty());
    let output = poll(handle);
    let (mut r, sequence) = header(&output, 5);
    assert!(!r.boolean().unwrap());
    assert_eq!(floats(&mut r), vec![0., 0., 0., 1., 0., 0., 0., 0., -1.]);
    assert_eq!(floats(&mut r), vec![0., 1., 0., 0., 1., 0., 0., 1., 0.]);
    assert_eq!(r.u32().unwrap(), 3);
    assert_eq!([r.u32().unwrap(), r.u32().unwrap(), r.u32().unwrap()], [0, 1, 2]);
    assert_eq!(r.offset, output.len());
    let framed = crate::process_packet(&Packet::new(101).word(handle).0);
    let mut r = Reader { data: &framed, offset: 0 };
    assert_eq!(r.u32().unwrap() as usize, framed.len()); assert_eq!(r.u32().unwrap(), 0);
    assert_eq!(&framed[8..], output);
    Packet::new(106).word(handle).word(sequence).run().unwrap();
    assert_eq!(poll(handle), 0u32.to_le_bytes());
    close(handle);
}

#[test]
fn graph_packet_points_retain_f64_source_stage_f32_colors_and_wait_for_ack() {
    let handle = open(2);
    let pending = poll(handle); let (_, sequence) = header(&pending, 1);
    node_reply(handle, sequence, false).run().unwrap();
    let source = poll(handle); let (_, sequence) = header(&source, 4);
    let mut points = Packet::new(105);
    points.word(handle).word(sequence).word(1).values(&[1.0000000001, 2., 3., -4., 5., -6.])
        .word(1).values(&[-0., f64::INFINITY, f64::NAN]).double(2.).string("float64").string("inline");
    points.run().unwrap();
    let output = poll(handle); let (mut r, sequence) = header(&output, 6);
    assert_eq!(floats(&mut r), vec![1., 3., -2., -4., -6., -5.]);
    assert!(r.boolean().unwrap()); let colors = floats(&mut r);
    assert_eq!(colors[0].to_bits(), (-0.0_f32).to_bits()); assert_eq!(colors[1], f32::INFINITY); assert!(colors[2].is_nan());
    assert_eq!(r.f64().unwrap(), 2.);
    assert_eq!((0..6).map(|_| r.f64().unwrap()).collect::<Vec<_>>(), vec![-4., -6., -5., 1., 3., -2.]);
    assert_eq!(r.offset, output.len()); assert_eq!(poll(handle), output);
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let source = &registry.programs[&handle].retained()[0];
        let crate::ImportedSource::Points(raw) = source.source.as_ref() else { panic!("raw points"); };
        assert_eq!(raw[0], 1.0000000001);
        assert_eq!(source.points.as_ref().unwrap().precision, "float64");
    });
    Packet::new(106).word(handle).word(sequence).run().unwrap();
    assert_eq!(poll(handle), 0u32.to_le_bytes()); close(handle);
}

#[test]
fn graph_packet_invalid_packets_do_not_retain_programs() {
    let programs = || REGISTRY.with(|registry| registry.borrow().programs.len());
    let before = programs();
    let mut invalid_edge = Packet::new(100);
    invalid_edge.wide(1).wide(1).word(1).word(1).word(1).string("root").word(1).string("bad").word(1);
    assert_eq!(invalid_edge.run(), Err(ImportError::InvalidPacket));
    let mut invalid_utf8 = Packet::new(100);
    invalid_utf8.wide(1).wide(1).word(1).word(1).word(1).word(1);
    invalid_utf8.0.push(255); invalid_utf8.word(0);
    assert_eq!(invalid_utf8.run(), Err(ImportError::InvalidPacket));
    let mut invalid_count = Packet::new(100);
    invalid_count.wide(1).wide(1).word(1).word(1).word(u32::MAX);
    assert_eq!(invalid_count.run(), Err(ImportError::InvalidPacket));
    assert_eq!(programs(), before, "a refused Open must not retain a program");
}

#[test]
fn graph_packet_empty_point_codec_result_finishes_without_output_or_assembly() {
    let handle = open(2);
    let pending = poll(handle); let (_, sequence) = header(&pending, 1);
    node_reply(handle, sequence, false).run().unwrap();
    let source = poll(handle); let (_, sequence) = header(&source, 4);
    Packet::new(105).word(handle).word(sequence).word(0).run().unwrap();
    assert_eq!(poll(handle), 0u32.to_le_bytes());
    REGISTRY.with(|registry| assert!(registry.borrow().programs[&handle].retained().is_empty()));
    close(handle);
}

#[test]
fn native_thread_handles_cannot_close_or_poll_another_threads_graph() {
    let first = open(1);
    let original = poll(first);
    std::thread::spawn(move || {
        let second = open(1);
        assert_ne!(first, second);
        Packet::new(107).word(first).run().unwrap(); // Foreign close is a no-op.
        assert_eq!(Packet::new(101).word(first).run(), Err(ImportError::IdentityMismatch));
        assert_eq!(poll(second)[..4], 1u32.to_le_bytes());
        close(second);
    }).join().unwrap();
    assert_eq!(poll(first), original);
    close(first);
}
