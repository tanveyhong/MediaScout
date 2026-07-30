"use strict";

const http = require("node:http");

function createWaveBuffer(durationSeconds = 2, frequency = 440) {
  const sampleRate = 22_050;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const fade = Math.min(1, index / 800, (sampleCount - index) / 800);
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    buffer.writeInt16LE(Math.round(sample * fade * 10_500), 44 + index * 2);
  }

  return buffer;
}

function fixturePage(port) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Media Scout Local Test</title>
    <style>
      :root { color-scheme: dark; font-family: "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: radial-gradient(circle at 50% 20%, #173229, #080b10 55%); color: #f4f7fb; }
      main { width: min(580px, calc(100% - 48px)); padding: 34px; border: 1px solid #304035;
        border-radius: 20px; background: #111720; box-shadow: 0 24px 80px #0008; }
      .tag { color: #68e5b2; font: 700 11px ui-monospace; letter-spacing: .13em; text-transform: uppercase; }
      h1 { margin: 10px 0 8px; font-size: 30px; }
      p { color: #9ba5b7; line-height: 1.55; }
      audio { width: 100%; margin: 22px 0; }
      code { display: block; padding: 12px; border-radius: 9px; background: #090c11; color: #bdebd8; }
      .ok { margin-top: 20px; padding-top: 18px; border-top: 1px solid #29313d; color: #c9d2df; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <span class="tag">Local fixture • Port ${port}</span>
      <h1>Detection test bench</h1>
      <p>This tone is generated locally and served as a direct WAV response. Playing it should
      create one audio result in Media Scout. Preview, Copy, and Save can be tested safely.</p>
      <audio controls preload="auto" src="/test-tone.wav"></audio>
      <code>http://127.0.0.1:${port}/test-tone.wav</code>
      <div class="ok">✓ No third-party service, account, or copyrighted media is involved.</div>
    </main>
  </body>
</html>`;
}

function createFixtureServer() {
  const wave = createWaveBuffer();
  return http.createServer((request, response) => {
    if (request.url === "/test-tone.wav") {
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": wave.length,
        "Content-Type": "audio/wav",
      });
      response.end(wave);
      return;
    }

    if (request.url === "/" || request.url === "/index.html") {
      const body = Buffer.from(fixturePage(response.socket.localPort));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(body);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
}

module.exports = { createFixtureServer, createWaveBuffer, fixturePage };
