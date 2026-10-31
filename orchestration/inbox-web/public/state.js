import { chooseLanguage, translate } from './i18n.js';
import { readTab } from './tabs.js';
import { KEYS, readColumns, readFilters } from './kanban-model.js';

export const state = {
  language: chooseLanguage(localStorage.getItem('inbox-language'), navigator.language),
  machine: new URL(location.href).searchParams.get('machine'),
  summary: undefined,
  data: undefined,
  campaign: new URL(location.href).searchParams.get('campaign'),
  drafts: {},
  editing: new Set(),
  expanded: new Set(),
  errors: {},
  closedVisible: false,
  menu: false,
  settings: false,
  busy: false,
  uploading: 0,
  pushOn: false,
  theme: localStorage.getItem('inbox-theme') || 'auto',
  systemTheme: matchMedia('(prefers-color-scheme:dark)'),
  root: document.getElementById('app'),
  refreshSequence: 0,
  selectedTab: null,
  userScroll: false,
  navScrollY: typeof scrollY === 'undefined' ? 0 : scrollY,
  guarded: false,
  pageUrl: location.href,
  view: new URL(location.href).searchParams.get('view') === 'routing' ? 'routing' : 'inbox',
  routing: null,
  tab: readTab(location.href),
  tabScroll: {},
  kanban: { board: null, error: null, sequence: 0, pop: null, sheet: false, drawer: null, columns: readColumns(localStorage.getItem(KEYS.columns)), filters: readFilters(localStorage.getItem(KEYS.filters)) },
};

export const t = (key, ...values) => translate(state.language, key, ...values);
document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
