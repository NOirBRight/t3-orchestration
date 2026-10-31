import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_MODULES } from './load-app.mjs';

const BUILTINS = new Set([
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'URL', 'Uint8Array', 'ArrayBuffer',
  'atob', 'btoa', 'console', 'document', 'window', 'navigator', 'location', 'history',
  'localStorage', 'matchMedia', 'scrollY', 'scrollTo', 'fetch', 'Response', 'Request',
  'Headers', 'FormData', 'File', 'Blob', 'Image', 'Worker', 'self', 'globalThis',
  'clearTimeout', 'setTimeout', 'clearInterval', 'setInterval', 'queueMicrotask',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'HTMLElement', 'Event', 'CustomEvent', 'DOMParser', 'AbortController', 'AbortSignal',
]);

function parseImports(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/).map(item => item.trim()).filter(Boolean);
      if (pieces.length) names.add(pieces[pieces.length - 1]);
    }
  }
  for (const match of source.matchAll(/import\s+(\w+)\s+from\s*['"](\.\/[^'"]+)['"]/g)) names.add(match[1]);
  return names;
}

function parseExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/).map(item => item.trim()).filter(Boolean);
      if (pieces.length) names.add(pieces[pieces.length - 1]);
    }
  }
  return names;
}

function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/^import\s.+?;$/gm, '')
    .replace(/^export\s+/gm, '');
}

function localBindings(source) {
  const names = new Set();
  for (const match of source.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^(?:const|let|var)\s+(\w+)/gm)) names.add(match[1]);
  return names;
}

async function readModules() {
  const directory = new URL('../public/', import.meta.url);
  const sources = {};
  for (const name of APP_MODULES) sources[name] = await readFile(new URL(name, directory), 'utf8');
  return sources;
}

test('前端模块调用的兄弟导出都必须 import', async () => {
  const sources = await readModules();
  const exportedBy = new Map();
  for (const [file, source] of Object.entries(sources)) {
    for (const name of parseExports(source)) exportedBy.set(name, file);
  }
  const problems = [];
  for (const [file, source] of Object.entries(sources)) {
    const imports = parseImports(source);
    const locals = new Set([...imports, ...parseExports(source), ...localBindings(source), ...BUILTINS]);
    const body = stripNoise(source);
    for (const [name, owner] of exportedBy) {
      if (owner === file || locals.has(name)) continue;
      // Only call sites: avoids e.message / dataset.card / local const card = ...
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) {
        problems.push(`${file} calls ${name}() from ${owner} without importing it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('拆到 state 后 app.js 不再使用裸 summary', async () => {
  const body = stripNoise((await readModules())['app.js']);
  // Allow state.summary; reject leftovers like ...summary.peers from the pre-split globals.
  const hits = [...body.matchAll(/(?<!state\.)\bsummary\b/g)].map(match => {
    const start = Math.max(0, match.index - 24);
    return body.slice(start, match.index + 16).replace(/\s+/g, ' ');
  });
  assert.deepEqual(hits, []);
});
