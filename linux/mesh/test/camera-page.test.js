// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Camera page tests for Linux Mesh:
// 1. Page registers (tab, left menu navigation, app.html, ui-phone clean)
// 2. Previews tile per phone (matched by wcId, Android 1/2 order, hint with real name)
// 3. Slot assignment moves a phone (one slot holds one phone)
// 4. Frames go only to the assigned slot's feed
// Run with: node linux/mesh/test/camera-page.test.js
'use strict';

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

// Mock electron ipcMain and BrowserWindow for tests
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
      app: Object.assign(new EventEmitter(), { getVersion: () => '2.4.0', quit: () => {}, getPath: (p) => '/tmp/' + p }),
      nativeTheme: new EventEmitter(),
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
      BrowserWindow: class extends EventEmitter {
        constructor(opts = {}) {
          super();
          this.opts = opts;
          this.visible = !opts.hidden;
          this.destroyed = false;
          this.webContents = new EventEmitter();
          this.webContents.id = Math.floor(Math.random() * 100000) + 1;
          this.webContents.isDestroyed = () => this.destroyed;
          this.webContents.send = (ev, ...args) => {
            this.webContents.emit(ev, ...args);
          };
        }
        show() { this.visible = true; }
        focus() { this.focused = true; }
        isVisible() { return this.visible && !this.destroyed; }
        isFocused() { return !!this.focused; }
        isDestroyed() { return this.destroyed; }
        close() { this.destroy(); }
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.visible = false;
          this.emit('closed');
          this.webContents.emit('destroyed');
        }
        setAspectRatio() {}
        loadFile() { return Promise.resolve(); }
      },
    };
  }
  return originalLoad.call(this, req, ...rest);
};

// Global DOM mocks for UI kit
global.URL = {
  createObjectURL: () => 'blob:mock/' + Math.random(),
  revokeObjectURL: () => {},
};
global.Blob = class Blob {
  constructor(parts, opts) { this.parts = parts; this.opts = opts; }
};

class MockEl {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = { ...attrs };
    this.style = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.className = attrs.class || '';
    if (attrs.text) this.textContent = attrs.text;
    this.append(...children);
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(new MockEl('span', { text: n }));
      else if (n) this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  removeAttribute(attr) { delete this.attrs[attr]; }
  setAttribute(attr, val) { this.attrs[attr] = val; }
  getAttribute(attr) { return this.attrs[attr]; }
  set src(v) { this.attrs.src = v; }
  get src() { return this.attrs.src; }
}

const registeredTabs = new Map();
let camPreviewCallback = null;

global.UI = {
  tab(def) { registeredTabs.set(def.id, def); },
  el(tag, attrs = {}, children = []) { return new MockEl(tag, attrs, children); },
  button(text, onClick, cls = '') {
    const b = new MockEl('button', { text, class: 'btn ' + cls });
    b.onclick = onClick;
    return b;
  },
  segmented(items, onChange) {
    let curVal = items[0] && items[0].value;
    return {
      el: new MockEl('div', { class: 'segmented' }),
      set(v) { curVal = v; },
      get() { return curVal; },
      disable(d) {},
    };
  },
  switch(onChange, opts = {}) {
    let checked = false;
    return {
      el: new MockEl('label', { class: 'switch' }),
      set(v) { checked = !!v; },
      get() { return checked; },
      disable(d) {},
    };
  },
  select(options, onChange) {
    let curVal = options[0] ? String(options[0].value) : '';
    const el = new MockEl('select');
    return {
      el,
      options(opts) {},
      set(v) { curVal = String(v); el.value = curVal; },
      get() { return curVal; },
    };
  },
  card(title, children = []) {
    return new MockEl('div', { class: 'card', title }, children);
  },
  row(title, hint, controls = []) {
    const r = new MockEl('div', { class: 'row' }, controls);
    r.title = title;
    r.hint = hint;
    r.setHint = function (h) { this.hint = h; };
    return r;
  },
  note(type, text) {
    const n = new MockEl('div', { class: 'note ' + type });
    n.set = (t) => { n.textContent = t; };
    n.set(text);
    return n;
  },
  api: {
    camera: (m) => ipcMain.invoke('camera', m),
    phoneCamera: (on, opts) => ipcMain.invoke('phoneCamera', on, opts),
    onCamPreview: (fn) => { camPreviewCallback = fn; },
  },
};

const { VirtualCam, FRAME } = require('../../../shared/vcam.js');
const M = require('../../../shared/sidebar-model.js');

function fakeMultiSlotDriver() {
  const d = {
    name: 'TwinDesk Camera',
    slots: ['TwinDesk Camera', 'TwinDesk Camera 2', 'TwinDesk Camera 3', 'TwinDesk Camera 4'],
    always: true,
    installed: true,
    feedsCount: 0,
    feedProcesses: new Map(), // slot -> mock proc
    writtenBySlot: new Map(),
    async check() { return { supported: true, installed: true }; },
    async install() { d.installed = true; },
    async remove() { d.installed = false; },
    feed(onExit, slot = 0) {
      d.feedsCount++;
      const p = new EventEmitter();
      p.slot = slot;
      p.stdin = Object.assign(new EventEmitter(), {
        write: (buf) => {
          d.writtenBySlot.set(slot, (d.writtenBySlot.get(slot) || 0) + 1);
          return true;
        },
        end: () => onExit(),
      });
      p.kill = () => {};
      d.feedProcesses.set(slot, p);
      return p;
    },
  };
  return d;
}

test('Camera page - registers, previews tile per phone, slot moves a phone, frames to assigned slot feed', async () => {
  // Test 1: Page registers
  console.log('Subtest 1: Page registration and navigation');
  require('../ui-camera.js');
  const camTab = registeredTabs.get('camera');
  assert.ok(camTab, 'camera tab registered in UI.tab');
  assert.strictEqual(camTab.id, 'camera');
  assert.strictEqual(camTab.group, 'More');
  assert.strictEqual(camTab.order, 75);
  assert.ok(typeof camTab.master.get === 'function');
  assert.ok(typeof camTab.master.set === 'function');

  // Sidebar model includes camera globally
  assert.ok(M.GLOBAL.includes('camera'), 'sidebar-model GLOBAL includes camera');
  assert.strictEqual(M.isScoped('camera'), false, 'camera is global tab');

  // app.html loads mesh/ui-camera.js
  const html = fs.readFileSync(path.resolve(__dirname, '../app.html'), 'utf8');
  assert.ok(html.includes('mesh/ui-camera.js'), 'app.html includes mesh/ui-camera.js');

  // ui-phone.js does not contain camCard and has Camera Settings button
  const phoneUi = fs.readFileSync(path.resolve(__dirname, '../ui-phone.js'), 'utf8');
  assert.ok(!phoneUi.includes('camCard'), 'ui-phone.js does not have camCard');
  assert.ok(phoneUi.includes("UI.go('camera')"), 'ui-phone.js links to camera page');

  // Test 2: Previews tile per phone
  console.log('Subtest 2: Previews tile per phone');
  const pageBody = new MockEl('div');
  const render = camTab.build(pageBody);

  const phone1 = {
    id: 'phone-1',
    name: 'Pixel 8',
    state: 'ready',
    camera: { on: true, facing: 'back', wcId: 1001, virtualActive: true, slot: 0 },
  };
  const phone2 = {
    id: 'phone-2',
    name: 'Galaxy S24',
    state: 'ready',
    camera: { on: true, facing: 'front', wcId: 1002, virtualActive: false, slot: 1 },
  };

  const stateWithTwoCameras = {
    camera: { on: true },
    vcam: { on: true, ready: true, name: 'TwinDesk Camera', slotMap: { 'phone-1': 0, 'phone-2': 1 } },
    phone: { phones: [phone1, phone2] },
  };

  render(stateWithTwoCameras);

  // Find preview grid
  const picCard = pageBody.children[0];
  assert.ok(picCard, 'picCard exists');
  const previewArea = picCard.children[0];
  const emptyBox = previewArea.children[0];
  const grid = previewArea.children[1];

  assert.strictEqual(emptyBox.hidden, true, 'empty box hidden when cameras running');
  assert.strictEqual(grid.hidden, false, 'grid visible when cameras running');
  assert.strictEqual(grid.children.length, 2, '2 preview tiles rendered for 2 running phones');

  // Check tile labels: "Android 1" and "Android 2" by order, real name as hint
  const tile1 = grid.children[0];
  const tile2 = grid.children[1];

  assert.ok(tile1.title.includes('Android 1'), 'tile 1 labelled Android 1');
  assert.ok(tile1.title.includes('Pixel 8'), 'tile 1 has Pixel 8 hint');
  assert.ok(tile2.title.includes('Android 2'), 'tile 2 labelled Android 2');
  assert.ok(tile2.title.includes('Galaxy S24'), 'tile 2 has Galaxy S24 hint');

  // Previews dispatch via onCamPreview
  assert.ok(typeof camPreviewCallback === 'function', 'camPreviewCallback registered');
  const p1Buf = Buffer.from('jpeg-1');
  const p2Buf = Buffer.from('jpeg-2');

  camPreviewCallback(p1Buf, 1001);
  const img1 = tile1.children[0];
  assert.ok(img1.src && img1.src.startsWith('blob:'), 'tile 1 updated with blob preview');

  camPreviewCallback(p2Buf, 1002);
  const img2 = tile2.children[0];
  assert.ok(img2.src && img2.src.startsWith('blob:'), 'tile 2 updated with blob preview');

  // Test 3: Slot assignment moves a phone (one slot holds one phone)
  console.log('Subtest 3: Slot assignment moves a phone');
  const driver = fakeMultiSlotDriver();
  const cfg = { virtual: true, rotate: 0 };
  const vcam = new VirtualCam({
    driver,
    cfg: () => cfg,
    save: () => {},
    onChange: () => {},
    onReady: () => {},
  });
  await vcam.check();
  await vcam.setOn(true);

  const wc1 = new EventEmitter();
  wc1.id = 1001;
  wc1.isDestroyed = () => false;
  wc1.send = () => {};

  const wc2 = new EventEmitter();
  wc2.id = 1002;
  wc2.isDestroyed = () => false;
  wc2.send = () => {};

  ipcMain.emit('vcam:hello', { sender: wc1 });
  ipcMain.emit('vcam:hello', { sender: wc2 });

  // Assign wc1 to slot 0 and wc2 to slot 1
  vcam.setSlot(wc1, 0);
  vcam.setSlot(wc2, 1);
  assert.strictEqual(vcam.getSlot(wc1), 0, 'wc1 assigned to slot 0');
  assert.strictEqual(vcam.getSlot(wc2), 1, 'wc2 assigned to slot 1');

  // Now move wc2 to slot 0 ("one slot holds one phone")
  vcam.setSlot(wc2, 0);
  assert.strictEqual(vcam.getSlot(wc2), 0, 'wc2 now has slot 0');
  assert.notStrictEqual(vcam.getSlot(wc1), 0, 'wc1 unseated from slot 0 when wc2 moved to slot 0');

  // Test 4: Frames go only to the assigned slot's feed
  console.log('Subtest 4: Frames go only to assigned slot feed');
  driver.writtenBySlot.clear();

  // wc2 is on slot 0 -> frames go to slot 0 feed
  ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));
  assert.strictEqual(driver.writtenBySlot.get(0), 1, 'wc2 frame went to slot 0 feed');
  assert.strictEqual(driver.writtenBySlot.get(1) || 0, 0, 'no frames on slot 1');

  // wc1 was unseated from slot 0 -> frames from unseated/off wc1 are dropped
  ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
  assert.strictEqual(driver.writtenBySlot.get(0), 1, 'unseated wc1 frame dropped from slot 0');
  assert.strictEqual(driver.writtenBySlot.get(1) || 0, 0, 'unseated wc1 frame dropped from slot 1');

  // Now assign wc1 to slot 1
  vcam.setSlot(wc1, 1);
  assert.strictEqual(vcam.getSlot(wc1), 1, 'wc1 now assigned to slot 1');

  // Send frames from both
  ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
  ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));

  assert.strictEqual(driver.writtenBySlot.get(0), 2, 'slot 0 feed received wc2 frames');
  assert.strictEqual(driver.writtenBySlot.get(1), 1, 'slot 1 feed received wc1 frames');

  vcam.stop();

  // Test 5: Linux vcam multi-guard tests
  console.log('Subtest 5: Linux vcam multi guard and UI slots behavior');
  const child_process = require('child_process');
  const linuxDriver = require('../../vcam.js');

  // (a) with multi off, the generated install script text equals upstream's, slots undefined
  linuxDriver.setMulti(false);
  assert.strictEqual(linuxDriver.slots, undefined, 'with multi off, driver.slots is undefined');

  let upstreamInstall = '';
  try {
    const upstreamCode = child_process.execSync('git show upstream/main:linux/vcam.js', { encoding: 'utf8' });
    const vm = require('vm');
    const m = upstreamCode.match(/const INSTALL = `([\s\S]*?)`;/);
    if (m) {
      // Evaluate template string with NAME = 'TwinDesk Camera' just like upstream does
      upstreamInstall = vm.runInNewContext('const NAME = "TwinDesk Camera"; `' + m[1] + '`').trim();
    }
  } catch {}

  const currentInstall = (linuxDriver.installScript ? linuxDriver.installScript() : linuxDriver.INSTALL).trim();
  if (upstreamInstall) {
    assert.strictEqual(currentInstall, upstreamInstall, 'generated install script matches upstream git show byte-for-byte');
  }
  // Also verify key lines
  assert.ok(currentInstall.includes('devices=1 exclusive_caps=1 card_label="TwinDesk Camera"') || currentInstall.includes('devices=1 exclusive_caps=1 card_label="${NAME}"'), 'install script sets devices=1 and single card_label');
  assert.ok(currentInstall.includes('OTHERS=$(grep -ls \'options v4l2loopback\''), 'preserves OTHERS check');
  assert.ok(currentInstall.includes('v4l2loopback-ctl add -n "TwinDesk Camera" -x 1') || currentInstall.includes('v4l2loopback-ctl add -n "${NAME}" -x 1'), 'preserves OBS-aware v4l2loopback-ctl branch');

  // (b) with multi on, 4 slots
  linuxDriver.setMulti(true);
  assert.ok(Array.isArray(linuxDriver.slots), 'with multi on, driver.slots is array');
  assert.strictEqual(linuxDriver.slots.length, 4, 'with multi on, driver.slots has 4 slots');
  assert.deepStrictEqual(linuxDriver.slots, [
    'TwinDesk Camera',
    'TwinDesk Camera 2',
    'TwinDesk Camera 3',
    'TwinDesk Camera 4',
  ]);
  linuxDriver.setMulti(false);
  assert.strictEqual(linuxDriver.slots, undefined, 'with multi off again, driver.slots is undefined');

  // (c) the page without slots shows no "Send to" and shows single "Camera source" row
  const stateNoSlots = {
    camera: { on: true },
    vcam: { on: true, ready: true, name: 'TwinDesk Camera', slots: null },
    phone: { phones: [phone1, phone2] },
  };
  render(stateNoSlots);

  // In pageBody: check that sendWraps are hidden and sourceRow is shown
  const sendWraps = [];
  function findSendWraps(el) {
    if (!el) return;
    if (el.className && el.className.includes('send-to-wrap')) sendWraps.push(el);
    if (el.children) for (const c of el.children) findSendWraps(c);
  }
  findSendWraps(pageBody);
  assert.ok(sendWraps.length > 0, 'sendWrap elements exist in phone rows');
  for (const sw of sendWraps) {
    assert.strictEqual(sw.hidden, true, 'send-to wrap must be hidden when driver reports no slots');
  }

  // Find sourceRow in vCard
  const vCard = pageBody.children[1];
  const sourceRow = vCard.children[0];
  assert.strictEqual(sourceRow.title, 'Camera source', 'Camera source row exists in vCard');
  assert.strictEqual(sourceRow.hidden, false, 'Camera source row is shown when driver reports no slots');

  // Now render with 4 slots: Send to wraps visible, Camera source row hidden
  const stateWithSlots = {
    camera: { on: true },
    vcam: { on: true, ready: true, name: 'TwinDesk Camera', slots: ['TwinDesk Camera', 'TwinDesk Camera 2', 'TwinDesk Camera 3', 'TwinDesk Camera 4'] },
    phone: { phones: [phone1, phone2] },
  };
  render(stateWithSlots);
  for (const sw of sendWraps) {
    assert.strictEqual(sw.hidden, false, 'send-to wrap must be visible when driver reports >= 2 slots');
  }
  assert.strictEqual(sourceRow.hidden, true, 'Camera source row must be hidden when driver reports >= 2 slots');

  console.log('All camera-page tests passed!');
});
