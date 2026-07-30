# Media Scout Companion

Load this folder as an unpacked extension in Edge or Chrome during development:

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `C:\Projects\MediaScout\browser-extension`.
5. Open the companion popup and enter the six-digit code shown on Media Scout's
   Extension setup page.
6. Keep Media Scout open and play a supported public video, including YouTube watch pages.

The extension sends detected HTTP(S) media requests only to `127.0.0.1:48731`.

When **Browser** is selected on a captured item, Media Scout queues a local command and the
companion opens that direct media URL in the connected browser session. Browser cookies and
tokens remain inside the browser and are never copied into Media Scout.
