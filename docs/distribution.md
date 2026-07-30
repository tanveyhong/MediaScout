# Distribution checklist

## Windows signing

The release workflow signs the executable and installer when both repository
secrets are configured:

- `WINDOWS_CERTIFICATE`: a base64-encoded Authenticode PFX or supported secure URL.
- `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password.

Obtain a certificate from a trusted Windows code-signing certificate authority,
protect the private key, configure both secrets, then verify the signature on a
release installer with `Get-AuthenticodeSignature`.

## Chrome Web Store and Microsoft Edge Add-ons

Run `pnpm pack:extension`. Upload the ZIP created in
`dist/extension-stores` to each developer dashboard. Store publication requires
the owner's developer account, listing text, screenshots, privacy disclosures,
and final review approval. Once store IDs are assigned, add their public listing
links to the in-app setup screen.

The unpacked companion remains available for development and installations that
cannot use a browser store.
