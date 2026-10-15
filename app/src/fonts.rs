//! Read installed metric-compatible faces at runtime. No OS fonts are bundled.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use pdf_toolkit::render::FallbackFonts;

pub fn fallback() -> FallbackFonts {
    static FONTS: OnceLock<FallbackFonts> = OnceLock::new();
    FONTS.get_or_init(load).clone()
}

/// Preserve spaces across styled spans and use real installed italic faces.
pub const READING_CSS: &str = ".semantic-content{font-family:Arial,'Liberation Sans',Inter}\n\
    .semantic-content span{white-space:pre-wrap}";

pub fn reading_context() -> blitz_dom::FontContext {
    let mut context =
        blitz_dom::build_single_font_ctx(include_bytes!(concat!(env!("OUT_DIR"), "/fallback.ttf")));
    for font in fallback().sans.iter().flatten() {
        context
            .collection
            .register_fonts(font.to_vec().into(), None);
    }
    context
}

fn read_font(path: &Path) -> Option<Arc<[u8]>> {
    const MAXIMUM: u64 = 16 << 20;
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAXIMUM {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAXIMUM + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAXIMUM {
        return None;
    }
    match bytes.get(..4)? {
        b"\0\x01\0\0" | b"OTTO" => Some(Arc::from(bytes)),
        _ => None,
    }
}

fn load() -> FallbackFonts {
    #[cfg(target_os = "macos")]
    let roots = [PathBuf::from("/System/Library/Fonts/Supplemental")];
    #[cfg(target_os = "windows")]
    let roots = [std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("Fonts")];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let roots = [
        PathBuf::from("/usr/share/fonts/truetype/liberation2"),
        PathBuf::from("/usr/share/fonts/truetype/liberation"),
        PathBuf::from("/usr/share/fonts/liberation"),
    ];

    let mut fonts = FallbackFonts::default();
    for (family, slots) in [
        ("Times New Roman", &mut fonts.serif),
        ("Arial", &mut fonts.sans),
        ("Courier New", &mut fonts.monospace),
    ] {
        for (style, slot) in slots.iter_mut().enumerate() {
            let name = filename(family, style);
            *slot = roots.iter().find_map(|root| read_font(&root.join(&name)));
        }
    }
    fonts
}

fn filename(family: &str, style: usize) -> String {
    #[cfg(target_os = "macos")]
    {
        let suffix = ["", " Bold", " Italic", " Bold Italic"][style];
        format!("{family}{suffix}.ttf")
    }
    #[cfg(target_os = "windows")]
    {
        let stem = match family {
            "Times New Roman" => "times",
            "Courier New" => "cour",
            _ => "arial",
        };
        let suffix = ["", "bd", "i", "bi"][style];
        format!("{stem}{suffix}.ttf")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let stem = match family {
            "Times New Roman" => "LiberationSerif",
            "Courier New" => "LiberationMono",
            _ => "LiberationSans",
        };
        let suffix = ["Regular", "Bold", "Italic", "BoldItalic"][style];
        format!("{stem}-{suffix}.ttf")
    }
}
