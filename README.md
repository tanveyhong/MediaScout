# Media Scout 0.2

Media Scout is a Windows desktop MVP that resolves supported public post URLs into complete
media files. It is intended for media the user owns, public-domain media, or sources whose
rights holder explicitly permits downloading.

Detected files are deduplicated by host and path. Each result can be opened in an in-app
audio/video preview before its link is copied or the file is saved.

## Safety boundaries

- Public YouTube watch, Shorts, and `youtu.be` URLs are supported without bypassing access controls.
- Adaptive playlists and segmented streaming formats such as HLS and DASH are excluded.
- The app does not bypass DRM, encryption, authentication, paywalls, or access controls.
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
5. Keep Media Scout open and play a supported public video.

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

For Microsoft Store submission, package the tested application as MSIX or use the Store's
supported Win32 installer submission path. Replace the placeholder app ID, author, branding,
icons, privacy policy, and publisher information before submission.
