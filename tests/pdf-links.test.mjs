import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePdfLinks} from '../extension/pdf-links.js';

const text = runs => runs.map(run => run.text).join('');
const links = runs => runs.filter(run => run.url);

test('legacy mentions become named links without exposing encoded nickname URLs', () => {
  const url = 'https://weibo.com/n/' + encodeURIComponent('示例手机');
  assert.deepEqual(parsePdfLinks(`支持@示例手机 (${url})。`), [
    {text: '支持'}, {text: '@示例手机', url}, {text: '。'},
  ]);
  const emoji = '摄影 小猫🐈', target = `https://weibo.com/n/${encodeURIComponent(emoji)}`;
  assert.deepEqual(parsePdfLinks(`谢谢@${emoji}（${target}）！`), [
    {text: '谢谢'}, {text: `@${emoji}`, url: target}, {text: '！'},
  ]);
});

test('adjacent supertopic and hashtag labels preserve prose and necessary query parameters', () => {
  const supertopic = 'https://weibo.com/p/10080800000000000000000000000000000001';
  const topic = 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#建筑观察#') + '&from=feed#result';
  const input = `沿街散步，记录窗台和树影。今天有许多新的发现。 示例城市超话 (${supertopic})#建筑观察# (${topic})\n继续正文。`;
  const result = parsePdfLinks(input);
  assert.equal(text(result), '沿街散步，记录窗台和树影。今天有许多新的发现。 示例城市超话#建筑观察#\n继续正文。');
  assert.deepEqual(links(result), [{text: '示例城市超话', url: supertopic}, {text: '#建筑观察#', url: topic}]);
});

test('multiple occurrences and long topics remain whole named spans for line and page wrapping', () => {
  const label = `#${'这是一个跨行话题'.repeat(45)}#`, url = 'https://s.weibo.com/weibo?q=' + encodeURIComponent(label);
  const result = parsePdfLinks(`${label} (${url})\n@甲 (https://weibo.com/u/1000000001) / @甲 (https://weibo.com/u/1000000001)`);
  assert.equal(links(result)[0].text, label);
  assert.equal(links(result).length, 3);
  assert.equal(text(result), `${label}\n@甲 / @甲`);
});

test('bounded URL parentheses and fullwidth wrappers retain the exact navigable target', () => {
  const target = 'https://example.test/search?q=chapter(one)&tag=two#section';
  assert.deepEqual(parsePdfLinks(`查看详情 (${target})。`), [{text: '查看详情', url: target}, {text: '。'}]);
  assert.deepEqual(parsePdfLinks(`《旅行笔记》（https://example.test/notes(one)）`), [{text: '《旅行笔记》', url: 'https://example.test/notes(one)'}]);
  assert.equal(text(parsePdfLinks('见 https://example.test/path(one). 下一句。')), '见 https://example.test/path(one). 下一句。');
  assert.equal(links(parsePdfLinks('见 https://example.test/path(one). 下一句。'))[0].url, 'https://example.test/path(one)');
});

test('ambiguous labels and ordinary parentheses remain visible while safe URLs are clickable', () => {
  for (const input of ['这是普通的一句说明 (https://example.test/a)', 'OpenAI Docs (https://example.test/docs)', '只有网址 (https://example.test/)']) {
    assert.equal(text(parsePdfLinks(input)), input);
    assert.equal(links(parsePdfLinks(input)).length, 1);
  }
  for (const input of ['说明（只是括号里的文字）', '@名字 (javascript:alert(1))', '正文', '', 'abchttps://example.test/']) {
    assert.equal(text(parsePdfLinks(input)), input);
    assert.equal(links(parsePdfLinks(input)).length, 0);
  }
});

test('unsafe and malformed destinations never hide source text or create active links', () => {
  const values = [
    'https://user:password@weibo.com/n/name', 'https://weibo.com/%0Aevil', 'https://weibo.com/%zz',
    'https://weibo.com/evil\\path', 'https://weibo.com/\u202Eevil', 'https://weibo.com/\u0001evil',
    'https://', 'https://weibo.com/' + 'x'.repeat(4096),
  ];
  for (const target of values) {
    const input = `查看详情 (${target})`;
    assert.equal(text(parsePdfLinks(input)), input);
    assert.equal(links(parsePdfLinks(input)).length, 0, target.slice(0, 100));
  }
  for (const input of ['查看详情 (https://example.test/\n恶意内容)', '查看详情 (https://example.test/ 未闭合', '查看详情 (https://example.test/a']) {
    assert.equal(text(parsePdfLinks(input)), input);
    assert.equal(links(parsePdfLinks(input)).length, 0);
  }
});

test('a rejected destination cannot consume a following valid named link', () => {
  const prefix = '查看详情 (https://user:password@evil.test/)\n';
  const result = parsePdfLinks(prefix + '#城市# (https://s.weibo.com/weibo?q=%23%E5%9F%8E%E5%B8%82%23)');
  assert.equal(text(result), prefix + '#城市#');
  assert.equal(links(result).length, 1);
});

test('long unmatched input is handled without recursive or backtracking parsing', () => {
  const input = '(' + 'https://example.test/'.repeat(15000) + '\n尾部原文';
  const result = parsePdfLinks(input);
  assert.equal(text(result), input);
  assert.equal(links(result).length, 0);
});
