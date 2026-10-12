# pdf-viewer

A pure Rust PDF viewer: an izumo window (Blitz and Boa, no OS webview) with a Solid interface built on
@pathscale/ui, reading documents through the `pdf-toolkit` crates.

Two views of every document: the page view (faithful rendering) and the reading view (the semantic document
reflowed like a web page: headings, paragraphs, links, images). Outline, thumbnails, search and zoom. Edit mode adds
highlights, notes, freehand ink, text boxes, rectangles and ellipses, page rotation, reordering, deletion and
insertion, document properties and undo; saving appends one incremental revision so the original bytes stay intact.

## Install

```sh
cargo install pdf-viewer
pdf-viewer --install-app
```

On macOS, `--install-app` writes `~/Applications/PDF Viewer.app` around the installed binary and makes it the
default app for PDF files; run it again after upgrading. `--uninstall-app` removes it. `pdf-viewer FILE.pdf` opens a
file directly on any platform.

## License

MIT. Text in unembedded standard fonts is drawn with Inter Regular (SIL Open Font License 1.1,
`app/assets/Inter-LICENSE`), positioned by the PDF's own glyph widths.

Run `pdf-viewer --bench-first-page <file.pdf>` to measure the first page without creating a window or
event loop. On success it prints one JSON line with `file`, `open_ms`, `first_page_ms` and `pages`.
`file` is the supplied path. Both durations are milliseconds from the start of opening: `open_ms`
ends after the normal open and parse path, and `first_page_ms` ends after page-size validation,
text-layer extraction and first-page rendering, including PNG encoding and base64 conversion.
Rendering uses the default page-view settings at device scale one and the normal pixel limit.
A text-layer failure still permits rendering, as in the window. Invalid arguments, open or render
failures, and documents without pages report an error on stderr and exit with status one.
