import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { URL, Date, module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), sandbox);
const { readCard } = sandbox.module.exports;

// A deliberately minimal DOM-shaped stub isolates timestamp provenance.
// It does not replace the real-DOM tests in adapter.browser.mjs.
function cardWithRepostTime(ownDatetime) {
  const plain = text => ({
    textContent: text,
    closest() { return null; },
    querySelectorAll() { return []; },
    cloneNode() { return { textContent: text, querySelectorAll() { return []; } }; },
  });
  const link = {
    ...plain('11-01'),
    getAttribute(name) { return name === 'href' ? '/1000000001/A1b2C3d4E' : name === 'title' ? '11-01' : null; },
    querySelector() { return null; },
  };
  const body = plain('Parent post text');
  const repost = { ...plain('Forwarded old post'), querySelector() { return null; }, querySelectorAll() { return []; } };
  const quotedTime = { ...plain('2020-05-01'), closest() { return repost; }, getAttribute() { return '2020-05-01T08:00:00Z'; } };
  const ownTime = { ...plain(''), getAttribute() { return ownDatetime; } };
  return {
    contains() { return true; },
    querySelector(selector) {
      if (selector === 'time[datetime]') return quotedTime;
      if (selector.includes('retweet')) return repost;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href]' || selector.includes('head_time')) return [link];
      if (selector.includes('feed_list_content')) return [body];
      if (selector === 'header time[datetime]') return ownDatetime ? [quotedTime, ownTime] : [quotedTime];
      return [];
    },
  };
}

test('unknown parent date cannot inherit a quoted post timestamp', () => {
  const post = readCard(cardWithRepostTime(), 'https://weibo.com/u/1000000001');
  assert.equal(post.dateRaw, '11-01');
  assert.equal(post.createdAt, null);
});

test('timestamp fallback uses an own-header time rather than a preceding quoted time', () => {
  const post = readCard(cardWithRepostTime('2026-11-01T09:14:00Z'), 'https://weibo.com/u/1000000001');
  assert.equal(post.createdAt, '2026-11-01T09:14:00.000Z');
});
