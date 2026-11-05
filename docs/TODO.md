# TODO

## Security queue follow-up

- [ ] Document `PDF_VIEWER_USE_REPO_UI=1` in developer build instructions and verify that the default embeds packaged `app/ui` assets while the opt-in requires the expected frontend package.
- [ ] Characterize which edit operations use incremental saves versus rewritten PDFs. Keep the warning limited to the absence of a secure-redaction guarantee; do not claim removed objects remain recoverable without evidence.
