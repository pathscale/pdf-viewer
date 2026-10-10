//! A net provider that answers `data:` URLs and nothing else.
//!
//! The interface's page images and bundled fonts are data URLs. A viewer has no
//! reason to reach the network, so every other scheme is simply never answered,
//! which also keeps a hostile document's links from fetching anything.

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};

pub struct DataUrlProvider;

impl NetProvider for DataUrlProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        if request.url.scheme() != "data" {
            return;
        }
        let url = request.url.as_str();
        if let Some(bytes) = decode(url) {
            handler.bytes(url.to_owned(), Bytes::from(bytes));
        }
    }
}

/// `data:[<media type>][;base64],<payload>`
fn decode(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (header, payload) = rest.split_once(',')?;
    if header.ends_with(";base64") {
        base64(payload.as_bytes())
    } else {
        Some(percent(payload.as_bytes()))
    }
}

fn base64(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in input {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn percent(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        if byte == b'%' && index + 2 < input.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(high), Some(low)) = (hex(input[index + 1]), hex(input[index + 2])) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    out
}
