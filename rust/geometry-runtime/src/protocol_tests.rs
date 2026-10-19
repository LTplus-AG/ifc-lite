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
fn retained_round1_staged_chunks_preserve_v1_envelopes_and_bound_arithmetic() {
    let session=0xfedcba9876543210;
    let bytes=encode_request(99,&KernelCommand::SweepChunk {
        session,upload:123,offset:3840,bytes:vec![17;3840] }).unwrap();
    assert_eq!(bytes.len(),3876);
    assert_eq!(&bytes[..4],&1u32.to_le_bytes());
    assert_eq!(&bytes[12..20],&session.to_le_bytes());
    assert_eq!(&bytes[36..],vec![17;3840]);
    for (offset,chunk) in [(u32::MAX,vec![1]),(0,vec![]),(0,vec![0;3841])] {
        assert_eq!(encode_request(1,&KernelCommand::SweepChunk {session,upload:123,offset,bytes:chunk}),
            Err(ProtocolError::PayloadSize));
    }
}

#[test]
fn sealed_empty_query_is_additive_opcode_19_and_preserves_solid_identity() {
    let solid = WireHandle { session: 0xfedcba9876543210, slot: 77, generation: 19 };
    let bytes = encode_request(43, &KernelCommand::IsEmpty { session: solid.session, solid }).unwrap();
    assert_eq!(&bytes[8..12], &19u32.to_le_bytes());
    assert_eq!(&bytes[12..20], &solid.session.to_le_bytes());
    assert_eq!(&bytes[20..], &solid.to_bytes());
}

#[test]
fn affine18_is_additive_and_preserves_input_matrix_bits_without_changing_rigid17() {
    let solid=WireHandle {session:(1u64<<60)+7,slot:3,generation:29};
    let matrix=[-2.,-0.,0.,0.,0.4,3.,0.,0.,0.2,0.3,4.,0.,7.,-4.,2.,1.];
    for (opcode,command) in [
        (17u32,KernelCommand::CopyTransform {session:solid.session,solid,column_major:matrix}),
        (18u32,KernelCommand::CopyAffine {session:solid.session,solid,column_major:matrix}),
    ] {
        let bytes=encode_request(91,&command).unwrap();
        assert_eq!(bytes.len(),164); assert_eq!(&bytes[8..12],&opcode.to_le_bytes());
        assert_eq!(&bytes[20..36],&solid.to_bytes());
        for (i,value) in matrix.iter().enumerate() {
            assert_eq!(&bytes[36+8*i..44+8*i],&value.to_le_bytes());
        }
    }
}

#[test]
fn only_opcode20_success_can_exceed_legacy_response_bound() {
    let solid=WireHandle { session:42,slot:1,generation:1 };
    let clip=KernelCommand::ClipPlane {session:42,solid,plane:[0.,0.,0.,0.,0.,1.],side:1,mode:2};
    let mut bytes=vec![0;MAX_PLANE_RESPONSE_BYTES];
    bytes[..4].copy_from_slice(&VERSION.to_le_bytes());bytes[4..8].copy_from_slice(&7u32.to_le_bytes());
    assert!(decode_command_response(7,&clip,&bytes).is_ok());
    assert!(decode_response(7,&bytes).is_err());
    assert!(decode_command_response(7,&KernelCommand::AbiVersion,&bytes).is_err());
    bytes[8..12].copy_from_slice(&8i32.to_le_bytes());
    assert!(decode_command_response(7,&clip,&bytes).is_err());
    bytes[8..12].fill(0);bytes.push(0);
    assert!(decode_command_response(7,&clip,&bytes).is_err());
    assert_eq!(encode_request(7,&clip).unwrap().len(),92);
    assert_eq!(MAX_REQUEST_BYTES,4096);
}
