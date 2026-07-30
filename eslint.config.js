"use strict";

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  __dirname: "readonly",
  console: "readonly",
  fetch: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly"
};

module.exports = [
  {
    files: ["src/**/*.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: { ecmaVersion: 2024, globals: nodeGlobals },
    rules: {
      "no-constant-condition": "error",
      "no-duplicate-imports": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["src/renderer.js"],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        document: "readonly",
        window: "readonly"
      }
    }
  },
  {
    files: ["browser-extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        chrome: "readonly",
        clearTimeout: "readonly",
        document: "readonly",
        innerHeight: "readonly",
        innerWidth: "readonly",
        location: "readonly",
        MutationObserver: "readonly",
        performance: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        fetch: "readonly",
        window: "readonly"
      }
    },
    rules: {
      "no-constant-condition": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];
