import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const APP_MODULES = [
  'icons.js',
  'tabs.js',
  'kanban-model.js',
  'state.js',
  'format.js',
  'api.js',
  'ui.js',
  'drafts.js',
  'routing.js',
  'kanban-view.js',
  'kanban.js',
  'render.js',
  'app.js',
];

const STATE_FIELDS = [
  'language', 'machine', 'summary', 'data', 'campaign', 'drafts', 'editing', 'expanded',
  'errors', 'closedVisible', 'menu', 'settings', 'busy', 'uploading', 'pushOn', 'theme',
  'refreshSequence', 'selectedTab', 'userScroll', 'navScrollY', 'guarded', 'pageUrl',
  'systemTheme', 'root', 'view', 'routing', 'tab', 'tabScroll', 'kanban',
];

export function stripModule(source) {
  return source
    .replace(/^import\s.+?;\r?\n/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\s+/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?\r?\n/gm, '')
    .replace(/^export\s+/gm, '');
}

function installAliases(context) {
  const state = vm.runInContext('state', context);
  for (const name of STATE_FIELDS) {
    Object.defineProperty(context, name, {
      get: () => state[name],
      set: value => { state[name] = value; },
      configurable: true,
      enumerable: true,
    });
  }
  for (const name of ['toast', 'render', 't']) {
    Object.defineProperty(context, name, {
      get: () => vm.runInContext(name, context),
      set: value => {
        context.__aliasValue = value;
        vm.runInContext(`${name} = globalThis.__aliasValue;`, context);
      },
      configurable: true,
      enumerable: true,
    });
  }
}

export async function readAppBundle() {
  const directory = new URL('../public/', import.meta.url);
  let source = '';
  for (const name of APP_MODULES) {
    source += `${stripModule(await readFile(new URL(name, directory), 'utf8'))}\n`;
  }
  return source;
}

export async function loadAppSource(context, { stopBefore } = {}) {
  const directory = new URL('../public/', import.meta.url);
  const dictionary = await readFile(new URL('i18n.js', directory), 'utf8');
  vm.runInContext(dictionary.replaceAll('export ', ''), context);
  let source = await readAppBundle();
  if (stopBefore) {
    const index = source.lastIndexOf(stopBefore);
    if (index < 0) throw new Error(`stopBefore marker not found: ${stopBefore}`);
    source = source.slice(0, index);
  }
  vm.runInContext(source, context);
  installAliases(context);
  return context;
}
