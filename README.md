# Media Scout 0.3

Media Scout is a Windows desktop MVP that resolves supported public post URLs into complete
media files. It is intended for media the user owns, public-domain media, or sources whose
rights holder explicitly permits downloading.

Detected files are deduplicated by host and path. Each result can be opened in an in-app
audio/video preview before its link is copied or the file is saved.

## Features

- Two-slot download queue with cancellation, supported direct-download pausing, progress,
  completion notifications, and persistent history.
- Batch URL capture, optional clipboard suggestions, quality/codec/file-size preferences,
  and audio-only YouTube downloads.
- Secure six-digit pairing between the desktop app and browser companion.
- Local diagnostics, sanitized rotating logs, incomplete-download cleanup, and privacy controls.
- Packaged-build update checks backed by GitHub Releases.

## Safety boundaries

- Public YouTube watch, Shorts, and `youtu.be` URLs are supported without bypassing access controls.
- Adaptive playlists and segmented streaming formats such as HLS and DASH are excluded.
- The app is designed for public URLs and does not intentionally bypass DRM, encryption,
  authentication, paywalls, or access controls.
- Every download requires a rights confirmation.

## Development

```powershell
pnpm install
pnpm dev
```

## Local test workflow

```powershell
pnpm verify
pnpm test:local
```

`test:local` starts a private server on `127.0.0.1`, opens Media Scout on its local test
page, and serves a generated WAV tone. Confirm that one result is detected and that Preview,
Copy, and Save behave correctly. Close Media Scout to stop the local server.

## Automatic Edge / Chrome / Opera GX public-page resolving

Media Scout starts a local capture bridge on `127.0.0.1:48731`. To connect a development
browser:

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `C:\Projects\MediaScout\browser-extension`.
5. Open the companion popup and enter the six-digit code shown in Media Scout.
6. Keep Media Scout open and play a supported public video.

The companion sends the public page URL—not browser cookies or media fragments—to the local
resolver. Complete results appear in the Capture shelf and Captures library. Private posts,
login-only content and DRM-protected media remain unsupported.

## Confirmed Windows release

EXE creation is deliberately blocked until explicit confirmation:

```powershell
$env:MEDIA_SCOUT_RELEASE_CONFIRMED='yes'
pnpm release
Remove-Item Env:MEDIA_SCOUT_RELEASE_CONFIRMED
```

The installer is written to `dist`. Do not run the release command until automated
verification and the interactive local test both pass.

## Automated releases

Pushing a version tag matching `package.json` (for example `v0.3.0`) runs verification,
builds the NSIS installer, generates update metadata and SHA-256 checksums, creates GitHub
build provenance attestations, and publishes a GitHub Release.

For Authenticode signing, configure these GitHub Actions secrets:

- `WINDOWS_CERTIFICATE`: base64-encoded `.pfx` certificate or a supported certificate URL.
- `WINDOWS_CERTIFICATE_PASSWORD`: the certificate password.

For Microsoft Store submission, package the tested application as MSIX or use the Store's
supported Win32 installer submission path. Replace the placeholder app ID, author, branding,
icons, privacy policy, and publisher information before submission.
