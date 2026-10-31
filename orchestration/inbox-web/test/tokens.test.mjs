import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// 一套设计令牌（第 39 条方向 C）：颜色、圆角、字号、阴影只在 style.css 顶部的两套变量里写值，规则只引用变量；明暗两套只换变量。
const publicFile = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const uncomment = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function tokenBlocks(css) {
  const light = /(^|\n):root \{([^}]*)\}/.exec(css), dark = /(^|\n):root\[data-theme="dark"\] \{([^}]*)\}/.exec(css);
  assert.ok(light && dark, 'style.css starts with a light :root block and a dark :root[data-theme="dark"] block');
  const parse = body => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(m => [m[1], m[2].trim()]));
  return { light: parse(light[2]), dark: parse(dark[2]), rest: css.replace(light[0], '\n').replace(dark[0], '\n') };
}
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|:\s*(?:white|black|red|green|blue|gray|grey|silver|orange|purple|yellow)\b/i;
const declarations = (css, property) => [...css.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'g'))].map(m => m[1].trim());

test('规则里不写颜色字面量，颜色只在两套令牌里', async () => {
  const { rest } = tokenBlocks(uncomment(await publicFile('style.css')));
  // 遮罩只取透明度，渐变里的 #000 不是界面颜色。
  const offenders = rest.split('\n').map(line => line.replace(/(?:-webkit-)?mask-image:[^;}]+/g, '')).filter(line => COLOUR.test(line));
  assert.deepEqual(offenders, [], 'hard-coded colours outside the token blocks');
});

test('深色主题覆盖浅色的每个颜色令牌，不多出浅色没有的令牌', async () => {
  const { light, dark } = tokenBlocks(uncomment(await publicFile('style.css')));
  const colourTokens = [...light].filter(([, value]) => COLOUR.test(`:${value}`) || /var\(--/.test(value) && /color-mix/.test(value)).map(([name]) => name);
  assert.ok(colourTokens.length >= 30, `found ${colourTokens.length} colour tokens`);
  for (const name of colourTokens) assert.ok(dark.has(name), `dark theme overrides ${name}`);
  for (const name of dark.keys()) assert.ok(light.has(name), `${name} is defined in the light block first`);
  for (const status of ['queued', 'running', 'blocked', 'verify', 'delivered', 'rework', 'merge', 'merged', 'closed', 'owner']) assert.ok(light.has(`--st-${status}`) && dark.has(`--st-${status}`), `status token --st-${status}`);
});

test('用到的变量都有定义（运行时内联的除外）', async () => {
  const css = uncomment(await publicFile('style.css'));
  const { light } = tokenBlocks(css);
  const local = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const runtime = new Set(['--x', '--y', '--d', '--indent']);
  const missing = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))].filter(name => !light.has(name) && !local.has(name) && !runtime.has(name));
  assert.deepEqual(missing, []);
});

test('圆角、字号、阴影只引用令牌', async () => {
  const { rest } = tokenBlocks(uncomment(await publicFile('style.css')));
  const radius = [...declarations(rest, 'border-radius'), ...declarations(rest, 'border-(?:top|bottom)-(?:left|right)-radius')].filter(value => !/^(?:(?:var\(--[\w-]+\)|0)\s*)+$/.test(value));
  assert.deepEqual(radius, [], 'border-radius uses --r-* tokens');
  const sizes = declarations(rest, 'font-size').filter(value => !/^(?:var\(--t-[\w-]+\)|[\d.]+em|inherit)$/.test(value));
  assert.deepEqual(sizes, [], 'font-size uses --t-* tokens');
  const fonts = declarations(rest, 'font').filter(value => !/^(?:inherit|var\(--t-[\w-]+\)\/[\d.]+ var\(--font\))$/.test(value));
  assert.deepEqual(fonts, [], 'font shorthand uses tokens');
  // 阴影的颜色和几何都走令牌：要么整条是高度令牌，要么是 0 偏移加宽度令牌的描边环。
  const shadows = declarations(rest, 'box-shadow').filter(value => value !== 'none' && /(?<![\w.-])[1-9][\d.]*px/.test(value));
  assert.deepEqual(shadows, [], 'box-shadow geometry uses --ring-*/--halo-w or elevation tokens');
});

test('控件尺寸和版面宽度只引用令牌；间距按 4px 栅格直接写', async () => {
  const { rest } = tokenBlocks(uncomment(await publicFile('style.css')));
  const literal = value => /(?<![\w.-])[1-9][\d.]*px/.test(value.replace(/var\(--[\w-]+\)/g, 'v').replace(/calc\([^()]*\)/g, ''));
  const sizes = ['height', 'min-height', 'max-height', 'width', 'min-width', 'max-width', 'flex', 'flex-basis', 'grid-template-columns', 'grid-auto-columns']
    .flatMap(property => declarations(rest, property).filter(literal).map(value => `${property}:${value}`));
  assert.deepEqual(sizes, [], 'sizes use --ctl-*/--tap/--badge/... tokens (offsets inside calc() are spacing)');
});

test('只有一张样式表；脚本不写颜色，状态栏颜色取自令牌', async () => {
  const files = await readdir(new URL('../public/', import.meta.url));
  assert.deepEqual(files.filter(name => name.endsWith('.css')), ['style.css']);
  for (const name of files.filter(name => name.endsWith('.html'))) {
    const html = await publicFile(name);
    for (const match of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)) assert.match(match[0], /href="style\.css"/, name);
    assert.doesNotMatch(html.replace(/<meta name="theme-color"[^>]*>/, ''), COLOUR, `${name}: no inline colours`);
  }
  for (const name of files.filter(name => name.endsWith('.js'))) {
    const js = await publicFile(name);
    assert.doesNotMatch(js, /['"`]#[0-9a-f]{3,8}['"`]|\brgba?\(/i, `${name}: no colour literals`);
    for (const match of js.matchAll(/style="([^"]*)"/g)) assert.match(match[1], /^(?:--[\w-]+:[^;]+;?)+$/, `${name}: inline styles only pass custom properties`);
  }
  const { light } = tokenBlocks(uncomment(await publicFile('style.css')));
  const bg = light.get('--bg');
  assert.match(await publicFile('index.html'), new RegExp(`<meta name="theme-color" content="${bg}">`), 'first paint matches the light --bg token');
  const manifest = JSON.parse(await publicFile('manifest.webmanifest'));
  assert.equal(manifest.theme_color, bg); assert.equal(manifest.background_color, bg);
  assert.match(await publicFile('render.js'), /getPropertyValue\('--bg'\)/, 'theme-color follows the active theme token');
});
