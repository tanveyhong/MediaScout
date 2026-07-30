"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCandidates,
  extractPageMetadata,
  normalizePublicPage,
  resolvePublicPage,
} = require("../src/page-resolver");

test("extracts the page title and thumbnail", () => {
  assert.deepEqual(
    extractPageMetadata(`
      <meta property="og:title" content="A public Reel">
      <meta property="og:image" content="https://cdn.example/poster.jpg?a=1&amp;b=2">
    `),
    {
      thumbnail: "https://cdn.example/poster.jpg?a=1&b=2",
      title: "A public Reel",
    },
  );
});

test("normalizes supported public Instagram URLs", () => {
  assert.equal(
    normalizePublicPage("https://instagram.com/reel/Abc_123-/?utm_source=test"),
    "https://www.instagram.com/reel/Abc_123-/",
  );
  assert.equal(
    normalizePublicPage("https://instagram.com/accounts/login/"),
    null,
  );
  assert.equal(normalizePublicPage("https://youtube.com/watch?v=x"), null);
});

test("normalizes public YouTube watch, Shorts, and short URLs", () => {
  const canonical = "https://www.youtube.com/watch?v=QQlFFcxJzwI";
  assert.equal(
    normalizePublicPage(
      "https://www.youtube.com/watch?v=QQlFFcxJzwI&feature=share",
    ),
    canonical,
  );
  assert.equal(
    normalizePublicPage("https://youtu.be/QQlFFcxJzwI?t=10"),
    canonical,
  );
  assert.equal(
    normalizePublicPage("https://m.youtube.com/shorts/QQlFFcxJzwI"),
    canonical,
  );
});

test("resolves YouTube video and separate audio streams", async () => {
  const result = await resolvePublicPage(
    "https://www.youtube.com/watch?v=QQlFFcxJzwI",
    {
      extractor: async () => ({
        requested_formats: [
          {
            acodec: "none",
            filesize: 1234,
            height: 1080,
            url: "https://video.example/playback",
            vcodec: "avc1",
            width: 1920,
          },
          {
            acodec: "mp4a",
            url: "https://audio.example/playback",
            vcodec: "none",
          },
        ],
        thumbnail: "https://img.example/cover.jpg",
        title: "Public YouTube video",
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, ["https://video.example/playback"]);
  assert.equal(
    result.analysis.audioSourceUrl,
    "https://audio.example/playback",
  );
  assert.equal(result.variants[0].label, "1080p");
});

test("normalizes public Bilibili video URLs", () => {
  assert.equal(
    normalizePublicPage(
      "https://bilibili.com/video/BV1AM4y177fr?spm_id_from=test",
    ),
    "https://www.bilibili.com/video/BV1AM4y177fr",
  );
});

test("normalizes public Douyin video and short URLs", () => {
  assert.equal(
    normalizePublicPage(
      "https://www.douyin.com/video/7657927426404582641?previous_page=test",
    ),
    "https://www.douyin.com/video/7657927426404582641",
  );
  assert.equal(
    normalizePublicPage("https://v.douyin.com/C0jNvEFxW24/?share=test"),
    "https://v.douyin.com/C0jNvEFxW24/",
  );
  assert.equal(
    normalizePublicPage(
      "https://www.douyin.com/user/self?from_tab_name=main&modal_id=7667554823587351846&showTab=like",
    ),
    null,
  );
  assert.equal(
    normalizePublicPage("https://www.douyin.com/?recommend=1"),
    null,
  );
});

test("extracts complete MP4 candidates from public page metadata", () => {
  const html = `
    <meta property="og:video" content="https://cdn.example/video.mp4?a=1&amp;b=2">
    <script>{"video_url":"https:\\/\\/cdn.example\\/second.mp4?x=1\\u0026y=2"}</script>
  `;
  assert.deepEqual(extractCandidates(html), [
    "https://cdn.example/video.mp4?a=1&b=2",
    "https://cdn.example/second.mp4?x=1&y=2",
  ]);
});

test("resolves complete direct media URLs", async () => {
  const url = "https://media.example/public/sample.webm";
  const result = await resolvePublicPage(url, {
    fetchImpl: async () => ({
      headers: new Headers({
        "content-length": "2048",
        "content-type": "video/webm",
      }),
      ok: true,
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [url]);
  assert.equal(result.candidateSizes[url], 2048);
});

test("resolves complete media metadata on an authorized domain", async () => {
  const result = await resolvePublicPage(
    "https://media.owner.example/watch/demo",
    {
      authorizedDomains: ["owner.example"],
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          '<meta property="og:video" content="/files/demo.mp4">',
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    "https://media.owner.example/files/demo.mp4",
  ]);
});

test("uses Internet Archive metadata for public media files", async () => {
  const result = await resolvePublicPage(
    "https://archive.org/details/public-sample",
    {
      fetchImpl: async () => ({
        json: async () => ({
          files: [
            { name: "movie.mp4", size: "4096" },
            { name: "playlist.m3u8", size: "10" },
          ],
          metadata: { title: "Public sample" },
        }),
        ok: true,
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0], /movie\.mp4$/);
  assert.equal(result.title, "Public sample");
});

test("resolves a public page without browser response fragments", async () => {
  const result = await resolvePublicPage(
    "https://instagram.com/reel/Test123/",
    {
      extractor: false,
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          '<meta property="og:video:secure_url" content="https://cdn.example/full.mp4">',
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, ["https://cdn.example/full.mp4"]);
});

test("falls back to the maintained public-page extractor", async () => {
  const result = await resolvePublicPage(
    "https://instagram.com/reel/Test123/",
    {
      extractor: async () => ({
        requested_downloads: [
          { url: "https://cdn.example/resolved.mp4?token=test" },
        ],
      }),
      fetchImpl: async () => ({ ok: true, text: async () => "<html></html>" }),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    "https://cdn.example/resolved.mp4?token=test",
  ]);
});

test("does not expose extractor video-only format variants", async () => {
  const result = await resolvePublicPage(
    "https://instagram.com/reel/Test123/",
    {
      extractor: async () => ({
        requested_downloads: [
          { url: "https://cdn.example/combined.mp4", format_id: "3" },
        ],
        formats: [
          {
            acodec: "none",
            format_id: "dash-video",
            url: "https://cdn.example/video-only.mp4",
            vcodec: "vp9",
          },
        ],
      }),
      fetchImpl: async () => ({ ok: true, text: async () => "<html></html>" }),
    },
  );
  assert.deepEqual(result.candidates, ["https://cdn.example/combined.mp4"]);
});

test("resolves one combined Bilibili progressive MP4", async () => {
  const responses = [
    {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          cid: 1178865721,
          pic: "http://cdn.example/bilibili-cover.jpg",
          title: "Public Bilibili video",
        },
      }),
    },
    {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          durl: [
            {
              size: 27_169_211,
              url: "https://cdn.example/bilibili-combined.mp4",
            },
          ],
        },
      }),
    },
  ];
  const result = await resolvePublicPage(
    "https://www.bilibili.com/video/BV1AM4y177fr",
    { fetchImpl: async () => responses.shift() },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    "https://cdn.example/bilibili-combined.mp4",
  ]);
  assert.equal(result.candidateSizes[result.candidates[0]], 27_169_211);
  assert.equal(result.thumbnail, "https://cdn.example/bilibili-cover.jpg");
});
