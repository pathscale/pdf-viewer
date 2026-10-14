#[path = "build_caps.rs"]
mod caps;

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>PDF Viewer</title>
</head>
<body>
<main id="root">
<h1>PDF Viewer</h1>
<p>Build the frontend bundle and rebuild the app to display documents.</p>
</main>
</body>
</html>
"#;

const PLACEHOLDER_CSS: &str = r#"
:root {
  color-scheme: light dark;
  --viewer-background: Canvas;
  --viewer-foreground: CanvasText;
}
body {
  margin: 0;
  background: var(--viewer-background);
  color: var(--viewer-foreground);
  font: 1rem/1.5 sans-serif;
}
main {
  max-width: 40rem;
  margin: 4rem auto;
  padding: 2rem;
}
h1 {
  font-size: 1.5rem;
}
"#;

fn asset(path: &Path, fallback: &[u8]) -> io::Result<Vec<u8>> {
    match caps::bytes(path) {
        Ok(bytes) => {
            std::str::from_utf8(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            Ok(bytes)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(fallback.to_vec()),
        Err(error) => Err(error),
    }
}

fn compress(path: &Path, bytes: &[u8], quality: u32) -> io::Result<()> {
    let file = fs::File::create(path)?;
    let mut encoder = brotli::CompressorWriter::new(file, 4096, quality, 22);
    encoder.write_all(bytes)?;
    encoder.flush()?;
    drop(encoder);
    Ok(())
}

fn embed() -> io::Result<()> {
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
        .ok_or_else(|| io::Error::other("CARGO_MANIFEST_DIR is missing"))?;
    let output =
        std::env::var_os("OUT_DIR").ok_or_else(|| io::Error::other("OUT_DIR is missing"))?;
    // The repo builds from frontend/dist; the published crate carries the same bundle in ui/.
    let manifest = PathBuf::from(manifest);
    let repo_dist = manifest.join("../frontend/dist");
    let dist = if repo_dist.join("index.html").is_file() {
        repo_dist
    } else {
        manifest.join("ui")
    };
    let output = PathBuf::from(output);

    println!("cargo:rerun-if-changed=../frontend");
    println!("cargo:rerun-if-changed=../frontend/dist");
    println!("cargo:rerun-if-changed=ui");
    for name in ["index.html", "app.js", "app.css"] {
        println!("cargo:rerun-if-changed=../frontend/dist/{name}");
    }

    let html = asset(&dist.join("index.html"), PLACEHOLDER_HTML.as_bytes())?;
    let js = asset(&dist.join("app.js"), b"")?;
    let css = asset(&dist.join("app.css"), PLACEHOLDER_CSS.as_bytes())?;
    let quality = if std::env::var("PROFILE").as_deref() == Ok("release") {
        9
    } else {
        2
    };

    compress(&output.join("embedded.html.br"), &html, quality)?;
    compress(&output.join("embedded.js.br"), &js, quality)?;
    compress(&output.join("embedded.css.br"), &css, quality)?;

    let generated = format!(
        "const HTML_LEN: usize = {};\n\
         const JS_LEN: usize = {};\n\
         const CSS_LEN: usize = {};\n\
         const HTML_BR: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.html.br\"));\n\
         const JS_BR: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.js.br\"));\n\
         const CSS_BR: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.css.br\"));\n",
        html.len(),
        js.len(),
        css.len(),
    );
    fs::write(output.join("embedded.rs"), generated)
}

fn be16(bytes: &[u8], at: usize) -> io::Result<u16> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .ok_or_else(|| io::Error::other("WOFF truncated"))
}

fn be32(bytes: &[u8], at: usize) -> io::Result<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| io::Error::other("WOFF truncated"))
}

/// WOFF 1.0 to sfnt: each table is stored zlib-compressed unless its compressed length equals its
/// original length. The renderer's fallback font loader takes plain TrueType.
fn woff_to_sfnt(woff: &[u8]) -> io::Result<Vec<u8>> {
    if be32(woff, 0)? != 0x774F_4646 {
        return Err(io::Error::other("not a WOFF 1.0 file"));
    }
    let flavor = be32(woff, 4)?;
    let count = usize::from(be16(woff, 12)?);
    caps::check("cache-entries", count as u64);
    caps::reserve_bytes((count as u64).saturating_mul(32));
    let mut tables = Vec::with_capacity(count);
    let mut decoded_total = 0_u64;
    for index in 0..count {
        caps::turn("asset build: WOFF table");
        let entry = 44 + index * 20;
        let tag = be32(woff, entry)?;
        let offset = be32(woff, entry + 4)? as usize;
        let compressed = be32(woff, entry + 8)? as usize;
        let original = be32(woff, entry + 12)? as usize;
        let checksum = be32(woff, entry + 16)?;
        decoded_total = decoded_total.saturating_add(original as u64);
        caps::check("decoded-bytes", decoded_total);
        caps::reserve_bytes(original as u64);
        let stored = woff
            .get(offset..offset + compressed)
            .ok_or_else(|| io::Error::other("WOFF table out of range"))?;
        let data = if compressed == original {
            stored.to_vec()
        } else {
            miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(stored, original)
                .map_err(|_| io::Error::other("WOFF table inflate failed"))?
        };
        if data.len() != original {
            return Err(io::Error::other("WOFF table length mismatch"));
        }
        tables.push((tag, checksum, data));
    }
    let mut search = 1usize;
    let mut selector = 0u16;
    while search * 2 <= count {
        search *= 2;
        selector += 1;
    }
    let sfnt_bytes = tables
        .iter()
        .fold(12u64 + count as u64 * 16, |n, (_, _, data)| {
            n.saturating_add(data.len().div_ceil(4) as u64 * 4)
        });
    caps::check("decoded-bytes", decoded_total.saturating_add(sfnt_bytes));
    caps::reserve_bytes(sfnt_bytes);
    let mut out = Vec::new();
    out.try_reserve_exact(usize::try_from(sfnt_bytes).map_err(io::Error::other)?)
        .map_err(io::Error::other)?;
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&(count as u16).to_be_bytes());
    out.extend_from_slice(&((search * 16) as u16).to_be_bytes());
    out.extend_from_slice(&selector.to_be_bytes());
    out.extend_from_slice(&((count * 16 - search * 16) as u16).to_be_bytes());
    let mut offset = 12 + count * 16;
    for (tag, checksum, data) in &tables {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, _, data) in &tables {
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    Ok(out)
}

/// Glyph shapes for unembedded standard fonts (advances still come from the PDF widths).
fn fallback_font() -> io::Result<()> {
    let output =
        std::env::var_os("OUT_DIR").ok_or_else(|| io::Error::other("OUT_DIR is missing"))?;
    let source = Path::new("assets/inter-latin-400-normal.woff");
    println!("cargo:rerun-if-changed={}", source.display());
    fs::write(
        PathBuf::from(output).join("fallback.ttf"),
        woff_to_sfnt(&caps::bytes(source)?)?,
    )
}

fn main() {
    caps::start(
        "pdf-viewer-asset-build",
        &[
            ("rss", 1073741824),
            ("cpu-secs", 120),
            ("wall-secs", 300),
            ("open-files", 256),
            ("threads", 32),
            ("procs", 2),
            ("input-bytes", 67108864),
            ("iterations", 10000),
            ("decoded-bytes", 134217728),
        ],
    );
    caps::stage("pdf-viewer-asset-build: dispatch");
    if let Err(error) = embed() {
        panic!("could not embed the PDF Viewer frontend: {error}");
    }
    if let Err(error) = fallback_font() {
        panic!("could not prepare the fallback font: {error}");
    }
}
