// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Remote (shared/phone-remote.js) as the one-to-one apps use it: one phone, the server's handlers get
// the message only (no connection argument). The Mesh's several phones must not change any of it:
// moves, keys and clicks reach the helper, what is held is let go, and nothing goes while this
// computer's mouse is elsewhere.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PhoneRemote } = require('../phone-remote.js');

const sent = [];
const server = Object.assign(new EventEmitter(), { current: { os: 'android' }, sendToClient: (m) => sent.push(m) });
let home = true;
const calls = [];
const helper = { send: (cmd, arg) => calls.push([cmd, arg]) };
const r = new PhoneRemote({ server, helper, getSettings: () => ({ remote: { allow: true } }), atHome: () => home });

// hello opens the page and the phone is told its state.
server.emit('t:remote.hello', {});
assert.ok(sent.length > 0, 'the phone hears its state');
assert.strictEqual(sent[sent.length - 1].allowed, true);

// A move, a click, a key and a wheel turn are injected as they are.
server.emit('t:remote.mm', { dx: 5, dy: -3 });
assert.deepStrictEqual(calls.pop(), ['inject', { ev: { t: 'k.mm', dx: 5, dy: -3, smooth: false } }]);
server.emit('t:remote.md', { b: 0 });
const down = calls.pop();
assert.strictEqual(down[0], 'inject');
assert.strictEqual(down[1].ev.b, 0);
server.emit('t:remote.ku', { code: 'KeyA' });
assert.strictEqual(calls.pop()[1].ev.code, 'KeyA');
assert.strictEqual(r.held, true, 'a held button is remembered');

// Releasing lets go of what is held here.
server.emit('t:remote.release', {});
assert.ok(calls.some((c) => c[0] === 'releaseAll'), 'released');
assert.strictEqual(r.held, false);

// Not at home: nothing is injected.
home = false;
calls.length = 0;
server.emit('t:remote.mm', { dx: 1, dy: 1 });
assert.strictEqual(calls.length, 0, 'nothing while the mouse is elsewhere');
home = true;

// A phone that goes away holding a key lets it go (the server's "closed" has no argument here).
server.emit('t:remote.kd', { code: 'KeyB' });
assert.strictEqual(r.held, true);
calls.length = 0;
server.emit('closed');
assert.ok(calls.some((c) => c[0] === 'releaseAll'), 'let go when the phone went');
assert.strictEqual(r.held, false);

console.log('phone-remote (one phone, one-to-one): ok');
process.exit(0);
