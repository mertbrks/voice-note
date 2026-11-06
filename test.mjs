// node test.mjs
import assert from 'node:assert/strict';
import { fileName, toMarkdown, b64utf8, parseJSON, splitText, dur } from './lib.js';

const n = { created: new Date(2026, 10, 6, 14, 5).getTime(), seconds: 125, title: 'Türev: zincir/kural?', tags: ['Ders', 'Hatırlatıcı'], summary: 'Özet.', bullets: ['a'], text: 'döküm' };
assert.equal(fileName(n), '2026-11-06 1405 Türev zincirkural.md');
assert.equal(dur(125), '02:05');
const md = toMarkdown(n);
assert.match(md, /tags: \[ders, hatırlatıcı\]/);
assert.match(md, /^# Türev: zincir\/kural\?$/m);
assert.equal(Buffer.from(b64utf8('çğış'), 'base64').toString('utf8'), 'çğış');
assert.deepEqual(parseJSON('tamam {"a":1} bitti'), { a: 1 });
const long = 'Bir cümle. '.repeat(3000);
const parts = splitText(long, 9000);
assert.ok(parts.every(p => p.length <= 9001) && parts.join(' ').length >= long.trim().length - parts.length);
assert.deepEqual(splitText('kısa', 9000), ['kısa']);
console.log('ok');
