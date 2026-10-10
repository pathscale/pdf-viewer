# pdf-viewer

A pure Rust PDF viewer: an izumo window (Blitz and Boa, no OS webview) with a Solid interface built on
@pathscale/ui, reading documents through the `pdf-toolkit` crates.

Two views of every document: the page view (faithful rendering) and the reading view (the semantic document
reflowed like a web page: headings, paragraphs, links, images). Outline, thumbnails, search and zoom. Edit mode adds
highlights, notes, freehand ink, text boxes, rectangles and ellipses, page rotation, reordering, deletion and
insertion, document properties and undo; saving appends one incremental revision so the original bytes stay intact.

MIT. Text in unembedded standard fonts is drawn with Inter Regular (SIL Open Font License 1.1,
`app/assets/Inter-LICENSE`), positioned by the PDF's own glyph widths.
