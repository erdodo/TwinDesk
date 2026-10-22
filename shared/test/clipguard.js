// Tests for shared/clipguard.js. Run with: node shared/test/clipguard.js
'use strict';
const assert = require('assert');
const { normText, textKey, imageKey, filesKey, EchoGuard, Breaker } = require('../clipguard.js');

// the same text on Windows (\r\n) and Mac (\n) has the same key
assert.strictEqual(textKey('a\r\nb\r\n'), textKey('a\nb'));
assert.strictEqual(textKey('a b  '), textKey('a b'));
assert.notStrictEqual(textKey('a'), textKey('b'));
assert.strictEqual(normText(null), '');
assert.strictEqual(filesKey([{ name: 'a', size: 1 }, { name: 'b', size: 2 }]), filesKey([{ name: 'b', size: 2 }, { name: 'a', size: 1 }]), 'order does not matter');
assert.notStrictEqual(imageKey(2, 2, 'x'), imageKey(2, 3, 'x'));

// echo: remembered for a few seconds only
let t = 1000;
const g = new EchoGuard({ ttlMs: 8000, now: () => t });
g.note(textKey('hello'));
assert.strictEqual(g.isEcho(textKey('hello')), true, 'what we just wrote is an echo');
assert.strictEqual(g.isEcho(textKey('other')), false);
t += 9000;
assert.strictEqual(g.isEcho(textKey('hello')), false, 'a person copying the same text later is a copy');

// breaker: a loop trips it, a person never does, and it comes back
t = 0;
const b = new Breaker({ max: 5, windowMs: 10000, pauseMs: 30000, now: () => t });
for (let i = 0; i < 5; i++) { t += 1000; assert.strictEqual(b.hit(), true, 'a person copying every second is fine'); }
t += 1000;
assert.strictEqual(b.hit(), false, 'the sixth copy within 10 s trips it');
assert.strictEqual(b.paused, true);
t += 10000;
assert.strictEqual(b.hit(), false, 'still paused');
t += 25000;
assert.strictEqual(b.paused, false);
assert.strictEqual(b.hit(), true, 'it resumes');
assert.strictEqual(b.trips, 1);
const slow = new Breaker({ max: 5, windowMs: 10000, now: () => t });
for (let i = 0; i < 50; i++) { t += 3000; assert.strictEqual(slow.hit(), true, 'one copy every 3 s never trips'); }
console.log('clipguard: passed');
