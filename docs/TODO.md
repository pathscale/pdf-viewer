# TODO

- [ ] Revalidate fallback font delivery for unembedded standard PDF fonts.
  Verify visible glyphs and semantic text with a neutral fixture; do not infer
  successful rendering from document load alone.

## Follow-ups

- [ ] Verify that the default embeds packaged `app/ui` assets while the `PDF_VIEWER_USE_REPO_UI=1` opt-in requires the expected frontend package.
- [ ] Characterize which edit operations use incremental saves versus rewritten PDFs. Keep the warning limited to the absence of a secure-redaction guarantee; do not claim removed objects remain recoverable without evidence. Also note that a rewritten save keeps only the catalog, info and ID trailer entries and drops dead references.
