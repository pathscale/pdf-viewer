# TODO

Audited 2026-10-14

Verified against `c356514` using source reads, `git log -S`, path history, and `bun run lint` in `frontend`: 14 errors (10 accessibility, 4 CSS import order) and 2 configuration notices. The accessibility markup predates this audit date, originating in `3d02c49` and `5c00c16` (2026-10-10). The current run does not report `useAriaPropsSupportedByRole` in `Thumbnail.tsx`.

## Open

- `useSemanticElements` reports 2 errors in `frontend/src/App.tsx:519,537`; start by replacing the document-view and zoom `div role="group"` wrappers with labeled semantic fieldsets and adjusting their styles.
- `useSemanticElements` reports 3 errors in `frontend/src/components/EditingToolbar.tsx:47,59,96`; start with semantic fieldsets for the annotation-tool, colour, and history/save groups, preserving their labels and layout.
- `noStaticElementInteractions` and `useAriaPropsSupportedByRole` report 2 errors on `frontend/src/components/AnnotationOverlay.tsx:503`; start by reviewing the dynamic button/group role, label, pointer handlers, and keyboard behavior, then make the overlay semantics explicit enough for lint to validate.
- `noStaticElementInteractions` and `useSemanticElements` report 2 errors in `frontend/src/components/Thumbnail.tsx:95,160`; start with the drag/drop wrapper's interaction semantics and a labeled fieldset for the page-organizing actions, preserving the separate navigation button.
- `noRedundantAlt` reports 1 error in `frontend/src/components/SemanticContent.tsx:178`; start by replacing the generic "Image extracted from the PDF" alt text with useful alternative text that omits the redundant word "Image".
- `noInvalidPositionAtImportRule` reports 4 errors in `frontend/src/index.css:4-7`; start by moving the remaining CSS imports before the Tailwind `@source` and `@plugin` directives and checking stylesheet order.
- Biome emits 2 configuration notices for `frontend/biome.json`: schema 2.4.15 differs from the locked CLI 2.5.15 in `frontend/bun.lock`, and `linter.rules.recommended` is deprecated; start by reviewing a configuration migration against `frontend/package.json` and the lockfile, then rerun `bun run lint` in `frontend`.
