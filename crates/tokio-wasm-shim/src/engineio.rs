//! engine.io v4 client framing for the per-server mail tunnel (`net`): a
//! server that offers `/engine.io/?port=…` (madmail) relays IMAP/SMTP to its
//! own listeners, so its accounts need no separate WebSocket-TCP bridge.
//!
//! Pure, compiled and unit-tested on every target, like `registry`.

use std::net::Ipv4Addr;

use base64::Engine as _;

/// Record separator between packets of one long-polling payload.
pub const SEP: char = '\u{1e}';

#[derive(Debug, PartialEq)]
pub enum Packet {
    Open {
        sid: String,
        ping_ms: u64,
    },
    Close,
    Ping,
    Binary(Vec<u8>),
    /// Pong, message (text), upgrade, noop: nothing the tunnel acts on.
    Other,
}

/// Decodes one packet (a WebSocket text frame or one polling record).
pub fn decode(packet: &str) -> Result<Packet, String> {
    let (kind, data) = packet.split_at(packet.len().min(1));
    Ok(match kind {
        "0" => {
            let open: serde_json::Value =
                serde_json::from_str(data).map_err(|e| format!("bad open packet: {e}"))?;
            let sid = open["sid"].as_str().ok_or("open packet without sid")?;
            let ping_ms = open["pingInterval"].as_u64().unwrap_or(25_000)
                + open["pingTimeout"].as_u64().unwrap_or(20_000);
            Packet::Open {
                sid: sid.to_string(),
                ping_ms,
            }
        }
        "1" => Packet::Close,
        "2" => Packet::Ping,
        "b" => Packet::Binary(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| format!("bad binary packet: {e}"))?,
        ),
        "" => return Err("empty packet".into()),
        _ => Packet::Other,
    })
}

/// A long-polling payload: binary as `b<base64>`, records joined by [`SEP`].
pub fn encode_binary(data: &[u8]) -> String {
    format!(
        "b{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}

/// The address `lookup_host` hands core for a tunneled host: core only ever
/// dials resolved IPs, so the host rides along in an IP that `connect` maps
/// back. 198.18.0.0/15 (RFC 2544 benchmarking) is never a real mail server.
/// Deterministic, since core persists resolved IPs in its DNS cache.
///
/// ponytail: 17-bit FNV-1a hash, so two tunneled hosts can collide (the later
/// lookup wins, the other's TLS handshake then fails on the name). Fine for a
/// handful of hosts; a counter persisted alongside core's cache if not.
pub fn synthetic_ip(host: &str) -> Ipv4Addr {
    let hash = host.bytes().fold(0x811c_9dc5u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    });
    Ipv4Addr::from(u32::from(Ipv4Addr::new(198, 18, 0, 0)) | (hash & 0x1_ffff))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_what_madmail_sends() {
        let open = r#"0{"sid":"AbC","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1048576}"#;
        assert_eq!(
            decode(open),
            Ok(Packet::Open {
                sid: "AbC".into(),
                ping_ms: 45_000
            })
        );
        let payload = format!("2{SEP}bYTEgTk9PUA0K{SEP}1");
        let packets: Vec<_> = payload.split(SEP).map(decode).collect();
        assert_eq!(
            packets,
            [
                Ok(Packet::Ping),
                Ok(Packet::Binary(b"a1 NOOP\r\n".to_vec())),
                Ok(Packet::Close)
            ]
        );
        assert_eq!(decode("6"), Ok(Packet::Other));
        assert!(decode("").is_err());
        assert!(decode("b!!").is_err());
        assert_eq!(encode_binary(b"a1 NOOP\r\n"), "bYTEgTk9PUA0K");
    }

    #[test]
    fn synthetic_ips_stay_in_the_benchmark_range() {
        for host in ["nine.testrun.org", "a.example", ""] {
            let ip = synthetic_ip(host).octets();
            assert_eq!(ip[0], 198);
            assert!(ip[1] == 18 || ip[1] == 19, "{ip:?}");
        }
        assert_eq!(synthetic_ip("x.example"), synthetic_ip("x.example"));
        assert_ne!(synthetic_ip("x.example"), synthetic_ip("y.example"));
    }
}
