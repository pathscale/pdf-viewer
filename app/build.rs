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
    match fs::read(path) {
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
    let output = std::env::var_os("OUT_DIR")
        .ok_or_else(|| io::Error::other("OUT_DIR is missing"))?;
    let dist = PathBuf::from(manifest).join("../frontend/dist");
    let output = PathBuf::from(output);

    println!("cargo:rerun-if-changed=../frontend");
    println!("cargo:rerun-if-changed=../frontend/dist");
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

fn main() {
    if let Err(error) = embed() {
        panic!("could not embed the PDF Viewer frontend: {error}");
    }
}

