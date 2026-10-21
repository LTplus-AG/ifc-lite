// SPDX-License-Identifier: MPL-2.0
use super::*;

// binary wire layout is the compatibility contract. Include tokens
// above JavaScript's integer precision to forbid number-based serialization.
#[test]
fn binary_layout_keeps_full_u64_tokens_and_f64_bits() {
    let session = (1u64 << 60) + 37;
    let handle = WireHandle {
        session,
        slot: 29,
        generation: 11,
    };
    let bytes = encode_request(
        73,
        &KernelCommand::Volume {
            session,
            solid: handle,
            relative_accuracy: 1e-8,
        },
    )
    .unwrap();
    assert_eq!(&bytes[..12], &[1, 0, 0, 0, 73, 0, 0, 0, 6, 0, 0, 0]);
    assert_eq!(&bytes[12..20], &session.to_le_bytes());
    assert_eq!(&bytes[20..36], &handle.to_bytes());
    assert_eq!(&bytes[36..], &1e-8f64.to_le_bytes());
    assert_eq!(WireHandle::from_bytes(&bytes[20..36]).unwrap(), handle);
    assert_eq!(
        WireHandle::from_bytes(&bytes[20..35]),
        Err(ProtocolError::ResultSize)
    );
}

#[test]
fn malformed_response_never_becomes_success() {
    let mut bytes = vec![1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        decode_response(7, &bytes).unwrap(),
        KernelResponse::Success(&[])
    );
    assert_eq!(decode_response(8, &bytes), Err(ProtocolError::RequestId));
    bytes[0] = 2;
    assert_eq!(decode_response(7, &bytes), Err(ProtocolError::Version));
    bytes[0] = 1;
    bytes[8] = 4;
    bytes.extend(b"invalid body");
    assert_eq!(
        decode_response(7, &bytes).unwrap(),
        KernelResponse::Failure {
            status: 4,
            message: "invalid body"
        }
    );
    bytes.push(0xff);
    assert_eq!(decode_response(7, &bytes), Err(ProtocolError::InvalidUtf8));
    assert_eq!(
        decode_response(7, &bytes[..11]),
        Err(ProtocolError::PayloadSize)
    );
    assert_eq!(
        decode_response(7, &vec![0; MAX_PAYLOAD_BYTES + 1]),
        Err(ProtocolError::PayloadSize)
    );
}

#[test]
fn all_commands_stay_bounded_and_mesh_chunks_cannot_wrap() {
    let session = 7;
    let h = WireHandle {
        session,
        slot: 0,
        generation: 1,
    };
    let commands = [
        KernelCommand::AbiVersion,
        KernelCommand::CreateSession,
        KernelCommand::DestroySession { session },
        KernelCommand::Box {
            session,
            origin: [0.; 3],
            size: [1.; 3],
        },
        KernelCommand::Cylinder {
            session,
            origin: [0.; 3],
            radius: 1.,
            height: 2.,
        },
        KernelCommand::Boolean {
            session,
            left: h,
            right: h,
            operation: BooleanOperation::Difference,
        },
        KernelCommand::Volume {
            session,
            solid: h,
            relative_accuracy: 1e-8,
        },
        KernelCommand::Manifold { session, solid: h },
        KernelCommand::Release { session, object: h },
        KernelCommand::Tessellate {
            session,
            solid: h,
            chord_metres: 0.001,
            angle_degrees: 15.,
        },
        KernelCommand::MeshInfo { session, mesh: h },
        KernelCommand::MeshRead {
            session,
            mesh: h,
            stream: MeshStream::Positions,
            offset: 0,
            count: 480,
        },
    ];
    for (opcode, command) in commands.iter().enumerate() {
        let bytes = encode_request(11, command).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            opcode as u32
        );
        assert!((12..=MAX_PAYLOAD_BYTES).contains(&bytes.len()));
    }
    for (offset, count) in [(0, 481), (u32::MAX, 1)] {
        assert_eq!(
            encode_request(
                0,
                &KernelCommand::MeshRead {
                    session,
                    mesh: h,
                    stream: MeshStream::Positions,
                    offset,
                    count
                }
            ),
            Err(ProtocolError::MeshChunkSize)
        );
    }
}

#[test]
fn rigid_copy_is_additive_opcode_17_and_preserves_matrix_bits() {
    let solid = WireHandle {
        session: (1u64 << 60) + 7,
        slot: 3,
        generation: 29,
    };
    let matrix = [
        -2., -0., 0., 0., 0.4, 3., 0., 0., 0.2, 0.3, 4., 0., 7., -4., 2., 1.,
    ];
    let bytes = encode_request(
        91,
        &KernelCommand::CopyTransform {
            session: solid.session,
            solid,
            column_major: matrix,
        },
    )
    .unwrap();
    assert_eq!(bytes.len(), 164);
    assert_eq!(&bytes[8..12], &17u32.to_le_bytes());
    assert_eq!(&bytes[20..36], &solid.to_bytes());
    for (i, value) in matrix.iter().enumerate() {
        assert_eq!(&bytes[36 + 8 * i..44 + 8 * i], &value.to_le_bytes());
    }
}

#[test]
fn staged_sweep_chunks_are_additive_opcodes_and_bound_their_frame() {
    let session = 0xfedc_ba98_7654_3210;
    let bytes = encode_request(
        99,
        &KernelCommand::SweepChunk {
            session,
            upload: 123,
            offset: 3840,
            bytes: vec![17; MAX_SWEEP_CHUNK_BYTES],
        },
    )
    .unwrap();
    // A full chunk frame stays inside the unchanged v1 request bound.
    assert_eq!(bytes.len(), 3876);
    assert!(bytes.len() <= MAX_REQUEST_BYTES);
    assert_eq!(&bytes[..4], &VERSION.to_le_bytes());
    assert_eq!(&bytes[8..12], &14u32.to_le_bytes());
    assert_eq!(&bytes[12..20], &session.to_le_bytes());
    assert_eq!(&bytes[20..28], &123u64.to_le_bytes());
    assert_eq!(&bytes[28..32], &3840u32.to_le_bytes());
    assert_eq!(&bytes[32..36], &3840u32.to_le_bytes());
    assert_eq!(&bytes[36..], vec![17; MAX_SWEEP_CHUNK_BYTES]);
    for (offset, chunk) in [
        (u32::MAX, vec![1]),
        (0, vec![]),
        (0, vec![0; MAX_SWEEP_CHUNK_BYTES + 1]),
    ] {
        assert_eq!(
            encode_request(
                1,
                &KernelCommand::SweepChunk {
                    session,
                    upload: 123,
                    offset,
                    bytes: chunk
                }
            ),
            Err(ProtocolError::PayloadSize)
        );
    }
    let begin = encode_request(
        2,
        &KernelCommand::SweepBegin {
            session,
            format: 2,
            length: 168,
            loops: 1,
            segments: 1,
        },
    )
    .unwrap();
    assert_eq!(&begin[8..12], &13u32.to_le_bytes());
    assert_eq!(begin.len(), 12 + 8 + 16);
    assert_eq!(&begin[20..24], &2u32.to_le_bytes());
    assert_eq!(&begin[24..28], &168u32.to_le_bytes());
    let consume = encode_request(3, &KernelCommand::SweepCommit { session, upload: 9 }).unwrap();
    assert_eq!(&consume[8..12], &15u32.to_le_bytes());
    assert_eq!(&consume[20..], &9u64.to_le_bytes());
}
