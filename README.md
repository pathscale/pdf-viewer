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
default app for PDF files; run it again after upgrading. Reinstalling the CLI does not refresh the `.app` copy.
After deciding to update the system copy, rebuild/install the CLI and run `pdf-viewer --install-app` again.
The installer also changes the default app for PDF files. `--uninstall-app` removes the bundle.
`pdf-viewer FILE.pdf` opens a file directly on any platform.

`pdf-viewer --version` prints the package version. `pdf-viewer --help` lists the command line options. Both exit
without starting the application runtime or opening a window. `-V` and `-h` are aliases.

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

## Local renderer verification

For local verification, use a gitignored `.cargo/config.toml` with `[patch.crates-io]` path overrides for
`pdf-toolkit`, `pdf-toolkit-core`, `pdf-toolkit-text`, `pdf-toolkit-render`, `pdf-toolkit-raster`,
`pdf-toolkit-write`, `pdf-toolkit-edit` and `pdf-toolkit-inspect`. Their toolkit workspace directories are
`pdf-toolkit`, `pdf-core`, `pdf-text`, `pdf-render`, `pdf-raster`, `pdf-write`, `pdf-edit` and `pdf-inspect`.
Check `cargo tree -i pdf-toolkit` to confirm which checkout is linked. Keep machine-specific paths out of commits.
The published 0.3.11 minimum alone does not include the local renderer fixes.

After `cargo install --path app --force --locked`, refresh an existing macOS bundle without changing the default PDF
handler by copying `~/.cargo/bin/pdf-viewer` to `~/Applications/PDF Viewer.app/Contents/MacOS/pdf-viewer`.
Check `--version` and `--bench-first-page FILE.pdf` on both copies; their SHA-256 hashes should match.
Verify every page through the viewer backend as well: a first-page benchmark does not establish render fidelity.
