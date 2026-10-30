// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Remote in Mesh (Mac): IPC wiring, per-phone gamepad player slots,
// multi-phone input injection and renderer page structure.
// Run with: node mac/mesh/test/remote.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

// Mock electron ipcMain for tests
const ipcMain = new EventEmitter();
ipcMain.handle = function (name, fn) {
  this._handlers = this._handlers || new Map();
  this._handlers.set(name, fn);
};
ipcMain.invoke = function (name, ...args) {
  const fn = this._handlers && this._handlers.get(name);
  if (!fn) throw new Error(`No IPC handler for ${name}`);
  return fn({ sender: {} }, ...args);
};

const originalLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      ipcMain,
      app: Object.assign(new EventEmitter(), { getVersion: () => '2.4.0', quit: () => {}, getPath: (p) => '/tmp/' + p, relaunch: () => {}, exit: () => {} }),
      nativeTheme: new EventEmitter(),
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 2 }) },
    };
  }
  return originalLoad.call(this, req, ...rest);
};

const P = require('../../../shared/protocol.js');
const { PhoneRemote, padBytes } = require('../../../shared/phone-remote.js');
const store = require('../../../mac/store.js');
const os = require('os');
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-remote-test-')));
const { setupIpc, TABS } = require('../ipc.js');
const M = require('../../../shared/sidebar-model.js');

// 1. Sidebar model & IPC tabs
{
  assert.ok(M.GLOBAL.includes('remote'), 'sidebar-model GLOBAL includes remote');
  assert.ok(!M.PHONE_ONLY.includes('remote'), 'sidebar-model PHONE_ONLY does not include remote');
  assert.ok(TABS.includes('remote'), 'mac/mesh/ipc.js TABS includes remote');

  // Verify preload ACTIONS includes setRemote
  const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'preload-control.js'), 'utf8');
  assert.ok(preloadCode.includes("'setRemote'"), 'preload-control.js ACTIONS includes setRemote');

  // IPC handler test
  let statePushed = 0;
  let saved = 0;
  let remoteAllowed = null;
  const mockRemote = {
    setAllow: (v) => { remoteAllowed = v; },
  };
  const mockCtx = {
    settings: { remote: { allow: true } },
    remote: () => mockRemote,
    state: { connect: {}, setup: { missing: [] } },
    pushState: () => statePushed++,
    save: () => saved++,
  };
  const actions = setupIpc(mockCtx);
  assert.strictEqual(typeof actions.setRemote, 'function');

  actions.setRemote({ allow: false });
  assert.strictEqual(remoteAllowed, false);
  assert.strictEqual(statePushed, 1);

  actions.setRemote({ allow: true });
  assert.strictEqual(remoteAllowed, true);
  assert.strictEqual(statePushed, 2);
  console.log('Test 1 passed: IPC and sidebar model registration');
}

// 2. Per-phone gamepad slots & multi-phone input
(async () => {
  const tick = () => new Promise((res) => setImmediate(res));
  const server = Object.assign(new EventEmitter(), {
    current: null,
    sendToClient: (m, id) => { sent.push({ m, id }); },
  });
  const sent = [];
  const injected = [];
  const helper = {
    send: (cmd, args) => injected.push({ cmd, args }),
    request: async () => ({ type: true }),
  };
  const settings = { remote: { allow: true, pad: true } };

  // Driver with feed processes
  const feeds = [];
  const driver = {
    name: 'Xbox 360 controller',
    check: async () => ({ supported: true, installed: true }),
    install: async () => {},
    feed: (onExit) => {
      const p = new EventEmitter();
      p.written = [];
      p.stdin = {
        write: (buf) => p.written.push(Buffer.from(buf)),
        end: () => onExit(0),
      };
      p.kill = () => {};
      feeds.push(p);
      return p;
    },
  };

  const r = new PhoneRemote({
    server,
    helper,
    getSettings: () => settings,
    atHome: () => true,
    loadPad: () => driver,
  });

  // Connect Phone 1, Phone 2, Phone 3, Phone 4
  const p1 = { id: 'phone-1', deviceId: 'phone-1', name: 'Pixel 8', os: P.OS.ANDROID };
  const p2 = { id: 'phone-2', deviceId: 'phone-2', name: 'Galaxy S24', os: P.OS.ANDROID };
  const p3 = { id: 'phone-3', deviceId: 'phone-3', name: 'Xiaomi 14', os: P.OS.ANDROID };
  const p4 = { id: 'phone-4', deviceId: 'phone-4', name: 'OnePlus 12', os: P.OS.ANDROID };
  const p5 = { id: 'phone-5', deviceId: 'phone-5', name: 'Xperia 1', os: P.OS.ANDROID };

  // Phone 1 says hello
  server.emit('t:remote.hello', {}, p1);
  await tick(); await tick();
  assert.strictEqual(r.view.phones.length, 1);
  assert.strictEqual(r.view.phones[0].slot, 1, 'Phone 1 gets slot 1');
  assert.strictEqual(r.view.phones[0].pad.live, true);
  assert.strictEqual(feeds.length, 1);

  // Phone 2 says hello
  server.emit('t:remote.hello', {}, p2);
  await tick(); await tick();
  assert.strictEqual(r.view.phones.length, 2);
  assert.strictEqual(r.view.phones[1].slot, 2, 'Phone 2 gets slot 2');
  assert.strictEqual(feeds.length, 2);

  // Phone 3 and 4 say hello
  server.emit('t:remote.hello', {}, p3);
  server.emit('t:remote.hello', {}, p4);
  await tick(); await tick();
  assert.strictEqual(r.view.phones[2].slot, 3, 'Phone 3 gets slot 3');
  assert.strictEqual(r.view.phones[3].slot, 4, 'Phone 4 gets slot 4');
  assert.strictEqual(feeds.length, 4);

  // Phone 5 says hello -> all 4 slots are occupied
  server.emit('t:remote.hello', {}, p5);
  await tick(); await tick();
  assert.strictEqual(r.view.phones.length, 5);
  assert.strictEqual(r.view.phones[4].slot, null, 'Phone 5 cannot get a slot (limit 4)');
  assert.strictEqual(r.view.phones[4].pad.live, false);

  // Input from Phone 1 writes to Phone 1's pad feed
  server.emit('t:remote.pad', { b: 1, lx: 0.5 }, p1);
  assert.strictEqual(feeds[0].written.length, 1);
  assert.strictEqual(feeds[1].written.length, 0);

  // Input from Phone 2 writes to Phone 2's pad feed
  server.emit('t:remote.pad', { b: 2, ly: -0.5 }, p2);
  assert.strictEqual(feeds[1].written.length, 1);

  // Touchpad move from Phone 2 carries phoneId
  server.emit(`t:${P.T.REMOTE_MOVE}`, { dx: 10, dy: 20 }, p2);
  const lastMove = injected[injected.length - 1];
  assert.strictEqual(lastMove.cmd, 'inject');
  assert.strictEqual(lastMove.args.ev.dx, 10);
  assert.strictEqual(lastMove.args.ev.dy, 20);

  // Phone 2 disconnects -> slot 2 becomes available
  server.emit('closed', { deviceId: 'phone-2' });
  await tick();
  const remainingSlots = r.view.phones.map((x) => x.slot).filter(Boolean);
  assert.ok(!remainingSlots.includes(2), 'Slot 2 freed when Phone 2 went away');

  // Mac configuration: no pad driver
  const macRemote = new PhoneRemote({
    server,
    helper,
    getSettings: () => ({ remote: { allow: true, pad: false } }),
    atHome: () => true,
    padNote: 'Real gamepad isn’t on the Mac',
  });
  assert.strictEqual(macRemote.view.pad.supported, false);
  assert.strictEqual(macRemote.view.pad.message, 'Real gamepad isn’t on the Mac');

  console.log('Test 2 passed: Per-phone gamepad slots, limit of 4, multi-phone injection, Mac padNote');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// 3. Renderer Page & Script Parsing
{
  const code = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'ui-remote.js'), 'utf8');
  new vm.Script(code); // parse test

  // Test DOM building with a mock UI environment simulating Mesh on Mac
  const tabs = [];
  const mockUI = {
    tabs,
    tab: (def) => tabs.push(def),
    isPhone: () => true,
    api: { setRemote: () => {} },
    card: (title, rows) => ({ type: 'card', title, rows }),
    row: (label, hint, items = []) => ({ type: 'row', label, hint, items, setHint(h) { this.hint = h; } }),
    note: (kind, text) => ({ type: 'note', kind, text, set(t) { this.text = t; } }),
    switch: (fn, opts) => ({ type: 'switch', set() {}, disable() {} }),
    el: (tag, props = {}) => ({
      tag, props, children: [],
      replaceChildren(...ch) { this.children = ch; },
      append(...ch) { this.children.push(...ch); },
    }),
  };

  const sandbox = {
    window: { SidebarModel: {} },
    document: { querySelector: () => ({}) },
    process: { platform: 'darwin' },
    navigator: { platform: 'MacIntel' },
    UI: mockUI,
    Buffer,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  assert.strictEqual(tabs.length, 1);
  const def = tabs[0];
  assert.strictEqual(def.id, 'remote');
  assert.strictEqual(def.group, 'More', 'Registered in More group in Mesh');
  assert.strictEqual(def.order, 77);

  const body = mockUI.el('div');
  const render = def.build(body);
  assert.strictEqual(typeof render, 'function');

  // Render with 0 phones
  render({ remote: { allow: true, phones: [] } });
  const phonesArea = body.children.find((c) => c.props && c.props.class === 'remote-phones');
  assert.ok(phonesArea, 'Found phonesArea');
  assert.strictEqual(phonesArea.children[0].title, 'Remote');
  assert.strictEqual(phonesArea.children[0].rows[0].label, 'No phones connected');
  assert.ok(phonesArea.children[0].rows[0].hint.includes('Connect a phone'));

  // Render with 2 phones: Android 1 and Android 2
  render({
    remote: {
      allow: true,
      phones: [
        { id: 'p1', name: 'My Pixel', label: 'Android 1', opened: true, using: false, slot: null },
        { id: 'p2', name: 'Work Galaxy', label: 'Android 2', opened: false, using: true, slot: null },
      ],
      pad: { supported: false, message: 'Real gamepad isn’t on the Mac' },
    },
  });
  assert.strictEqual(phonesArea.children.length, 2);
  assert.strictEqual(phonesArea.children[0].title, 'Android 1 as a remote');
  assert.strictEqual(phonesArea.children[1].title, 'Android 2 as a remote');
  assert.ok(phonesArea.children[0].rows[1].label.includes('My Pixel'));
  assert.ok(phonesArea.children[1].rows[0].hint.includes('In use: Work Galaxy'));

  // Verify on Mac: no pad switch rendered
  const padCard = body.children.find((c) => c.type === 'card' && c.title === 'Gamepad');
  assert.ok(padCard, 'Gamepad card present');
  const hasPadSwitch = padCard.rows.some((r) => r.items && r.items.some((i) => i.type === 'switch'));
  assert.strictEqual(hasPadSwitch, false, 'No Real gamepad switch on Mac');

  console.log('Test 3 passed: Page registration in More group, Android 1/2 labels, real name hints, no Mac pad switch');
}
