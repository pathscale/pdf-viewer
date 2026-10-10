use std::io::Read;

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

pub const UI_URL: &str = "pdf-viewer://ui/";
const JS_URL: &str = "pdf-viewer://ui/app.js";

struct EmbeddedScriptFetcher;

impl blitz_script::ScriptFetcher for EmbeddedScriptFetcher {
    fn fetch(&self, url: &blitz_traits::net::Url) -> Result<String, blitz_script::FetchError> {
        if url.scheme() == "pdf-viewer"
            && url.host_str() == Some("ui")
            && url.path().ends_with("/app.js")
        {
            decompress(JS_BR, JS_LEN, "JavaScript")
                .map_err(blitz_script::FetchError::InvalidData)
        } else {
            Err(blitz_script::FetchError::InvalidData(format!(
                "the embedded interface has no script at {url}"
            )))
        }
    }
}

fn decompress(bytes: &[u8], length: usize, label: &str) -> Result<String, String> {
    let mut decoded = String::new();
    decoded
        .try_reserve_exact(length)
        .map_err(|error| format!("could not allocate embedded {label}: {error}"))?;
    brotli::Decompressor::new(bytes, 4096)
        .take((length as u64).saturating_add(1))
        .read_to_string(&mut decoded)
        .map_err(|error| format!("could not decompress embedded {label}: {error}"))?;
    if decoded.len() != length {
        return Err(format!("embedded {label} length does not match its manifest"));
    }
    Ok(decoded)
}

fn inline_css(html: &str, css: &str) -> String {
    let mut output = String::new();
    let mut remaining = html;

    while let Some(start) = remaining.find("<link") {
        output.push_str(remaining.get(..start).unwrap_or_default());
        let tag_start = remaining.get(start..).unwrap_or_default();
        let Some(end) = tag_start.find('>') else {
            output.push_str(tag_start);
            remaining = "";
            break;
        };
        let end = end.saturating_add(1);
        let tag = tag_start.get(..end).unwrap_or_default();
        if !tag.contains("app.css") {
            output.push_str(tag);
        }
        remaining = tag_start.get(end..).unwrap_or_default();
    }
    output.push_str(remaining);

    let style = format!("<style>{css}</style>");
    if output.contains("</head>") {
        output = output.replacen("</head>", &format!("{style}</head>"), 1);
    } else {
        output.insert_str(0, &style);
    }

    if !output.contains("app.js") {
        let script = format!("<script src=\"{JS_URL}\"></script>");
        if output.contains("</body>") {
            output = output.replacen("</body>", &format!("{script}</body>"), 1);
        } else {
            output.push_str(&script);
        }
    }
    output
}

const SHELL_SHIM: &str = r#"
(function () {
  "use strict";

  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = function () {
      this.observe = function () {};
      this.unobserve = function () {};
      this.disconnect = function () {};
    };
  }

  function localPath(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    if (!value.startsWith("file:")) return value;
    try {
      var url = new URL(value);
      if (url.protocol !== "file:" ||
          (url.hostname !== "" && url.hostname !== "localhost")) return null;
      var path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      return path;
    } catch (_) {
      return null;
    }
  }

  function droppedPath(event) {
    var transfer = event.dataTransfer;
    if (!transfer) return null;
    if (transfer.files && transfer.files.length > 0) {
      var file = transfer.files[0];
      if (file && typeof file.path === "string") return localPath(file.path);
    }
    if (typeof transfer.getData !== "function") return null;
    var uris = transfer.getData("text/uri-list");
    if (!uris) return null;
    var lines = uris.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.startsWith("file:")) return localPath(line);
    }
    return null;
  }

  document.addEventListener("dragover", function (event) {
    event.preventDefault();
  });

  document.addEventListener("drop", function (event) {
    var path = droppedPath(event);
    if (!path || !window.__IZUMO__) return;
    event.preventDefault();
    window.__IZUMO__.invoke("open_file", { path: path }).catch(function (error) {
      console.error("Could not open dropped PDF:", error);
      window.__IZUMO__._emit("document_open_failed", String(error));
    });
  });

  function replayDocument() {
    var bridge = window.__IZUMO__;
    if (!bridge) {
      setTimeout(replayDocument, 10);
      return;
    }
    bridge.invoke("__viewer_current_document", {}).then(function (info) {
      if (info) bridge._emit("document_opened", info);
    }).catch(function (error) {
      console.error("Could not read the initial PDF:", error);
    });
  }

  setTimeout(replayDocument, 0);
})();
"#;

pub fn document(url: &str) -> Result<blitz_script::ScriptDocument, String> {
    if !url.starts_with(UI_URL) {
        return Err(format!("unsupported interface URL: {url}"));
    }
    let html = decompress(HTML_BR, HTML_LEN, "HTML")?;
    let css = decompress(CSS_BR, CSS_LEN, "CSS")?;
    // The interface's page images and bundled fonts are data: URLs, which the
    // document only loads through a net provider.
    let net: std::sync::Arc<dyn blitz_traits::net::NetProvider> =
        std::sync::Arc::new(crate::data_url::DataUrlProvider);
    let config = blitz_dom::DocumentConfig {
        base_url: Some(url.to_owned()),
        net_provider: Some(net),
        ..Default::default()
    };
    let mut document = blitz_script::ScriptDocument::from_html(&inline_css(&html, &css), config)
        .with_fetcher(EmbeddedScriptFetcher);
    document.eval(SHELL_SHIM);
    Ok(document)
}

