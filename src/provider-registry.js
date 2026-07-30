"use strict";

const { classifyMedia, parseHttpUrl } = require("./policy");

const PUBLIC_CONTENT_DOMAINS = Object.freeze([
  "archive.org",
  "wikimedia.org",
  "wikipedia.org",
]);

function normalizeDomainList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,;]+/);
  return [
    ...new Set(
      values
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean)
        .map((entry) => {
          try {
            return new URL(
              entry.includes("://") ? entry : `https://${entry}`,
            ).hostname.toLowerCase();
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ].slice(0, 100);
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function genericProviderFor(rawUrl, authorizedDomains = []) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const publicContentHost = PUBLIC_CONTENT_DOMAINS.some((domain) =>
    hostMatches(host, domain),
  );
  const publicDescriptionPage =
    /^\/(?:details|wiki)\//i.test(parsed.pathname) ||
    (hostMatches(host, "archive.org") &&
      !/^\/download\/[^/]+\/.+/i.test(parsed.pathname));
  if (publicContentHost && publicDescriptionPage) {
    parsed.hash = "";
    return { id: "public-content", url: parsed.href };
  }
  const direct = classifyMedia(parsed.href);
  if (direct.allowed) {
    return { id: "direct-media", url: parsed.href };
  }
  if (publicContentHost) {
    parsed.hash = "";
    return { id: "public-content", url: parsed.href };
  }
  const allowed = normalizeDomainList(authorizedDomains).some((domain) =>
    hostMatches(host, domain),
  );
  if (!allowed) return null;
  parsed.hash = "";
  return { id: "authorized-domain", url: parsed.href };
}

const PROVIDERS = Object.freeze([
  {
    description: "Complete HTTP(S) audio and video files",
    id: "direct-media",
  },
  {
    description: "Internet Archive and Wikimedia public pages",
    id: "public-content",
  },
  {
    description: "Pages on domains explicitly authorized by the user",
    id: "authorized-domain",
  },
]);

module.exports = {
  genericProviderFor,
  normalizeDomainList,
  PROVIDERS,
  PUBLIC_CONTENT_DOMAINS,
};
