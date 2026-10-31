// 四个分区是真 tab（P109）：地址里的 ?tab= 决定显示哪一页，决定页不写参数；旧的 #sec- 锚点仍能打开对应分区。
export const TABS = ['decide', 'accept', 'message', 'progress'];
export function readTab(href) {
  const url = new URL(href), value = url.searchParams.get('tab') || /^#sec-(\w+)$/.exec(url.hash)?.[1];
  return TABS.includes(value) ? value : TABS[0];
}
export function tabHref(href, tab) {
  const url = new URL(href);
  if (tab === TABS[0]) url.searchParams.delete('tab'); else url.searchParams.set('tab', tab);
  url.hash = '';
  return url.href;
}
// 已结案的题都收在决定页底部。
export const itemTab = item => (item.kind === 'accept' && item.status !== 'closed' ? 'accept' : 'decide');
