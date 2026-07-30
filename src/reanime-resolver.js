"use strict";

const crypto = require("node:crypto");
const vm = require("node:vm");

const REANIME = "https://reanime.to";
const FLIXCLOUD = "https://flixcloud.cc";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SEGMENT_XOR_KEY = Buffer.from([
  157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197,
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function derivedFields(seed) {
  let first = seed;
  for (let index = 0; index < 3; index += 1) {
    first = sha256(first + index);
  }
  let second = first;
  for (let index = 0; index < 3; index += 1) {
    second = sha256(second + index);
  }
  return {
    arrayName: `ad_${first.substring(32, 40)}`,
    containerName: `cd_${first.substring(24, 32)}`,
    ivField: `ivf_${first.substring(16, 24)}`,
    keyField: `kf_${first.substring(8, 16)}`,
    keyFrag2Field: `${second.substring(0, 16)}_${second.substring(16, 24)}`,
    objectName: `od_${first.substring(40, 48)}`,
    tokenField: `${first.substring(48, 64)}_${first.substring(56, 64)}`,
  };
}

function extractSsrData(html) {
  const marker = html.match(/\{type:"data",data:(\{)/);
  if (!marker) throw new Error("FlixCloud SSR data was not found.");
  const start = html.indexOf("{", marker.index + marker[0].length - 1);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      const literal = html.slice(start, index + 1);
      return vm.runInNewContext(`(${literal})`, Object.create(null), {
        codeGeneration: { strings: false, wasm: false },
        timeout: 1_000,
      });
    }
  }
  throw new Error("FlixCloud SSR data was incomplete.");
}

async function runWasm(wasmBase64, frag1, keyFragment, tokenKey, seed) {
  const { instance } = await WebAssembly.instantiate(
    Buffer.from(wasmBase64, "base64"),
    {},
  );
  const {
    _c: getPlaylistKey,
    _r: transform,
    _s: setSeed,
    memory,
  } = instance.exports;
  const length = frag1.length;
  const offsets = [
    1_000,
    1_000 + length,
    1_000 + 2 * length,
    1_000 + 3 * length,
  ];
  const heap = new Uint8Array(memory.buffer);
  heap.set(frag1, offsets[0]);
  heap.set(keyFragment, offsets[1]);
  heap.set(tokenKey, offsets[2]);
  setSeed(Number.parseInt(seed.substring(0, 8), 16));
  transform(...offsets, length);
  const playlistKeyOffset = getPlaylistKey();
  return {
    playlistKey: Buffer.from(
      heap.subarray(playlistKeyOffset, playlistKeyOffset + 32),
    ),
    wasmOutput: Buffer.from(heap.subarray(offsets[3], offsets[3] + length)),
  };
}

function decodePlaylist(encodedPlaylist, playlistKey) {
  const encrypted = Buffer.from(String(encodedPlaylist).trim(), "base64");
  const key = Buffer.isBuffer(playlistKey)
    ? playlistKey
    : Buffer.from(playlistKey, "base64");
  if (!encrypted.length || !key.length) {
    throw new Error("FlixCloud returned an empty protected playlist.");
  }
  const decoded = Buffer.allocUnsafe(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    decoded[index] = encrypted[index] ^ key[index % key.length];
  }
  const manifest = decoded.toString("utf8");
  if (!manifest.startsWith("#EXTM3U")) {
    throw new Error("FlixCloud playlist decoding failed.");
  }
  return manifest;
}

function decodeSegment(value) {
  const segment = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let payload;
  let encrypted = true;
  if (
    segment.length >= 13 &&
    segment.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    segment.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    payload = Buffer.from(segment.subarray(12));
    encrypted = segment[12] !== 0x47;
  } else if (
    segment.length >= 9 &&
    segment
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    payload = Buffer.from(segment.subarray(8));
    encrypted = segment[8] !== 0x47;
  } else {
    return segment;
  }
  if (encrypted) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= SEGMENT_XOR_KEY[index & 15];
    }
  }
  return payload;
}

async function decryptEmbed(embedUrl, fetchImpl) {
  const embedResponse = await fetchImpl(embedUrl, {
    headers: { Referer: `${REANIME}/`, "User-Agent": USER_AGENT },
  });
  if (!embedResponse.ok) {
    throw new Error(`FlixCloud embed returned HTTP ${embedResponse.status}.`);
  }
  const data = extractSsrData(await embedResponse.text());
  const seed = data.obfuscation_seed;
  const fields = derivedFields(seed);
  const cryptoObject =
    data.obfuscated_crypto_data[fields.containerName][fields.arrayName][0][
      fields.objectName
    ];
  const frag1 = Buffer.from(cryptoObject[fields.keyField], "base64");
  const iv = Buffer.from(cryptoObject[fields.ivField], "base64");
  const keyFragment = Buffer.from(data[fields.keyFrag2Field], "base64");
  const token = data[fields.tokenField];
  const tokenResponse = await fetchImpl(
    `${FLIXCLOUD}/api/m3u8/${encodeURIComponent(token)}`,
    { headers: { Referer: `${REANIME}/`, "User-Agent": USER_AGENT } },
  );
  if (!tokenResponse.ok) {
    throw new Error(`FlixCloud token returned HTTP ${tokenResponse.status}.`);
  }
  const tokenData = await tokenResponse.json();
  const encryptedUrl = Buffer.from(
    tokenData[sha256(`${token}vid`).substring(0, 10)],
    "base64",
  );
  const tokenKey = Buffer.from(
    tokenData[sha256(`${token}key`).substring(0, 10)],
    "base64",
  );
  const { playlistKey, wasmOutput } = await runWasm(
    data.w_payload,
    frag1,
    keyFragment,
    tokenKey,
    seed,
  );
  const material = crypto.pbkdf2Sync(wasmOutput, seed, 1_000, 32, "sha256");
  for (let index = 0; index < material.length; index += 1) {
    material[index] ^= seed.charCodeAt(index % seed.length);
  }
  const aesKey = crypto.createHash("sha256").update(material).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  const url = Buffer.concat([decipher.update(encryptedUrl), decipher.final()])
    .toString("utf8")
    .trim();
  if (!/^https?:\/\/.+\.m3u8(?:[?#]|$)/i.test(url)) {
    throw new Error("FlixCloud returned an invalid stream URL.");
  }
  return { data, playlistKey: playlistKey.toString("base64"), url };
}

async function resolveReanimePage(pageUrl, fetchImpl = globalThis.fetch) {
  try {
    const parsed = new URL(pageUrl);
    const slug = parsed.pathname.match(/^\/watch\/([^/]+)\/?$/)?.[1];
    const episode = Number(parsed.searchParams.get("ep"));
    const language = parsed.searchParams.get("lang") || "sub";
    const serverName = parsed.searchParams.get("server") || "HD-2";
    if (!slug || !Number.isInteger(episode) || episode < 1) {
      return { ok: false, reason: "This Re:ANIME watch URL is invalid." };
    }
    const watchResponse = await fetchImpl(
      `${REANIME}/api/watch/${encodeURIComponent(slug)}/${episode}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    const watch = watchResponse.ok ? await watchResponse.json() : {};
    let pageHtml = "";
    let anilist =
      Number(watch?.anime?.anilist || watch?.anime?.anilist_id) ||
      Number(
        JSON.stringify(watch?.anime?.cover_image || {}).match(
          /\/bx(\d+)-/,
        )?.[1],
      );
    if (!anilist) {
      const pageResponse = await fetchImpl(pageUrl, {
        headers: { "User-Agent": USER_AGENT },
      });
      pageHtml = pageResponse.ok ? await pageResponse.text() : "";
      anilist = Number(
        pageHtml.match(/["'](?:anilist|anilist_id)["']\s*:\s*(\d+)/i)?.[1] ||
          pageHtml.match(
            /anilistcdn\/media\/anime\/cover\/[^/]+\/bx(\d+)-/i,
          )?.[1],
      );
    }
    if (!anilist) {
      return {
        ok: false,
        reason: "Re:ANIME did not expose an AniList identifier.",
      };
    }
    const flixResponse = await fetchImpl(
      `${REANIME}/api/flix/${anilist}/${episode}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (!flixResponse.ok) {
      return {
        ok: false,
        reason: `Re:ANIME servers returned HTTP ${flixResponse.status}.`,
      };
    }
    const flix = await flixResponse.json();
    const server =
      (flix.servers || []).find(
        (item) =>
          item.serverName === serverName &&
          String(item.dataType || "").includes(language),
      ) ||
      (flix.servers || []).find((item) => item.serverName === serverName) ||
      flix.servers?.[0];
    if (!server?.dataLink) {
      return { ok: false, reason: "Re:ANIME exposed no FlixCloud server." };
    }
    const decrypted = await decryptEmbed(server.dataLink, fetchImpl);
    return {
      candidateTypes: {
        [decrypted.url]: "application/vnd.apple.mpegurl",
      },
      candidates: [decrypted.url],
      ok: true,
      pageUrl,
      playlistKey: decrypted.playlistKey,
      provider: "reanime",
      subtitles: Array.isArray(decrypted.data.subtitles)
        ? decrypted.data.subtitles
            .filter((subtitle) => /^https?:\/\//i.test(subtitle?.url || ""))
            .map((subtitle) => ({
              default: Boolean(subtitle.default),
              format: String(subtitle.format || ""),
              language: String(subtitle.language || "Subtitle"),
              url: subtitle.url,
            }))
        : [],
      thumbnail: decrypted.data.thumbnail || "",
      title:
        decrypted.data.video_title ||
        watch?.anime?.title ||
        pageHtml.match(
          /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
        )?.[1] ||
        slug,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "Unable to decrypt this Re:ANIME stream.",
    };
  }
}

module.exports = {
  decodePlaylist,
  decodeSegment,
  decryptEmbed,
  resolveReanimePage,
};
