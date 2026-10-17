//! Pure helpers for the per-server mail tunnel (`net`): a server that offers
//! `/mailtunnel` (madmail) relays IMAP/SMTP to its own listeners, so its
//! accounts need no separate WebSocket-TCP bridge.
//!
//! Compiled and unit-tested on every target, like `registry`.

use std::net::{Ipv4Addr, Ipv6Addr};

/// `host` as it goes into a URL: IPv6 literals in brackets.
pub fn url_host(host: &str) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
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
    fn url_hosts() {
        assert_eq!(url_host("mail.example"), "mail.example");
        assert_eq!(url_host("203.0.113.7"), "203.0.113.7");
        assert_eq!(url_host("2001:db8::7"), "[2001:db8::7]");
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
