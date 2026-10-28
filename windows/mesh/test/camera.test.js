// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Camera sharing in Mesh (Windows): UI registration, multi-phone camera windows,
// per-phone camera state, virtual camera slots, and IPC wiring.
// Run with: node --test mesh/test/camera.test.js
'use strict';

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');
const net = require('net');

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
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      clipboard: { writeText: () => {} },
      shell: { openExternal: async () => {} },
      Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
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
        hide() { this.visible = false; }
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
        isAlwaysOnTop() { return false; }
        setAlwaysOnTop() {}
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
    this.tagName = (tag || 'div').toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = attrs.title || '';
    this.src = attrs.src || '';
    this.className = attrs.class || '';
    if (attrs.text) this.textContent = attrs.text;
    if (children && children.length) this.append(...children);
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === 'string') {
        const textNode = new MockEl('span');
        textNode.textContent = n;
        this.children.push(textNode);
      } else {
        this.children.push(n);
      }
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }
}

let camPreviewCallback = null;
const registeredTabs = new Map();

global.UI = {
  api: {
    camera: () => {},
    phoneCamera: () => {},
    onCamPreview: (fn) => { camPreviewCallback = fn; },
  },
  state: {},
  tab(def) {
    registeredTabs.set(def.id, def);
    return def;
  },
  card(title, children) {
    const el = new MockEl('div', { class: 'card' }, children);
    el.titleText = title;
    return el;
  },
  row(label, hint, controls = []) {
    const el = new MockEl('div', { class: 'row' }, controls);
    el.label = label;
    el.hint = hint;
    el.setHint = (h) => { el.hint = h; };
    return el;
  },
  button(label, onclick, cls = '') {
    const el = new MockEl('button', { class: 'btn ' + cls });
    el.textContent = label;
    el.onclick = onclick;
    return el;
  },
  switch(onchange, opts = {}) {
    const el = new MockEl('input', { type: 'checkbox' });
    let val = false;
    return {
      el,
      set: (v) => { val = !!v; el.checked = val; },
      get: () => val,
      disable: (d) => { el.disabled = !!d; },
    };
  },
  select(opts, onchange) {
    const el = new MockEl('select');
    let curVal = '';
    return {
      el,
      options: (o) => { el.opts = o; },
      set: (v) => { curVal = v; el.value = v; },
      get: () => curVal,
    };
  },
  segmented(items, onchange) {
    const el = new MockEl('div', { class: 'segmented' });
    let curVal = items && items[0] ? items[0].value : '';
    return {
      el,
      set: (v) => { curVal = v; },
      get: () => curVal,
      disable: (d) => { el.disabled = !!d; },
    };
  },
  note(type, text) {
    const el = new MockEl('div', { class: 'note note-' + type });
    el.textContent = text;
    return { el, set: (t) => { el.textContent = t; } };
  },
  el(tag, attrs, children) {
    return new MockEl(tag, attrs, children);
  },
};

const { VirtualCam, FRAME } = require('../../../shared/vcam.js');
const { Phone } = require('../../phone.js');
const { PhoneBridge } = require('../phone-bridge.js');
const { PhoneViews } = require('../../phoneview.js');
const { PhoneSet } = require('../phones.js');
const setupIpc = require('../ipc.js');
const M = require('../../../shared/sidebar-model.js');

function fakeMultiSlotDriver() {
  const d = {
    name: 'TwinDesk Camera',
    slots: ['TwinDesk Camera', 'TwinDesk Camera 2', 'TwinDesk Camera 3', 'TwinDesk Camera 4'],
    always: true,
    installed: true,
    feedsCount: 0,
    feedProcesses: new Map(),
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

test('Camera sharing in Windows Mesh', async (t) => {
  // Test 1: Page registration & sidebar model
  await t.test('Page registration, navigation and app.html loading', () => {
    require('../ui-camera.js');
    const camTab = registeredTabs.get('camera');
    assert.ok(camTab, 'camera tab registered in UI.tab');
    assert.strictEqual(camTab.id, 'camera');
    assert.strictEqual(camTab.group, 'More');
    assert.strictEqual(camTab.order, 75);
    assert.ok(typeof camTab.master.get === 'function', 'has master switch get');
    assert.ok(typeof camTab.master.set === 'function', 'has master switch set');

    // Sidebar model
    assert.ok(M.GLOBAL.includes('camera'), 'camera is in sidebar GLOBAL');
    assert.strictEqual(M.isScoped('camera'), false, 'camera is a global tab');
    assert.strictEqual(M.sectionVisible('camera', 'phone'), true, 'visible when phone selected');
    assert.strictEqual(M.sectionVisible('camera', 'computer'), true, 'visible when computer selected');

    // app.html loads mesh/ui-camera.js
    const html = fs.readFileSync(path.resolve(__dirname, '../app.html'), 'utf8');
    assert.ok(html.includes('mesh/ui-camera.js'), 'windows/mesh/app.html loads mesh/ui-camera.js');
    assert.ok(html.includes('blob:'), 'app.html CSP includes blob: for JPEG previews');

    // ui-phone.js does not contain camera card and links to camera page
    const phoneUi = fs.readFileSync(path.resolve(__dirname, '../ui-phone.js'), 'utf8');
    assert.ok(!phoneUi.includes('camCard'), 'no camCard in ui-phone.js');
    assert.ok(phoneUi.includes("UI.go('camera')"), 'ui-phone.js links to camera page');
  });

  // Test 2: Preview grid tiles per running phone
  await t.test('Preview grid tiles per running phone with Android 1/2 labels and blob previews', () => {
    const camTab = registeredTabs.get('camera');
    const pageBody = new MockEl('div');
    const render = camTab.build(pageBody);

    const phone1 = {
      id: 'phone-1',
      name: 'Pixel 8',
      state: 'ready',
      camera: { on: true, facing: 'back', wcId: 501, virtualActive: true, slot: 0 },
    };
    const phone2 = {
      id: 'phone-2',
      name: 'Galaxy S24',
      state: 'ready',
      camera: { on: true, facing: 'front', wcId: 502, virtualActive: false, slot: 1 },
    };

    const stateWithTwoCameras = {
      camera: { on: true },
      vcam: { on: true, ready: true, name: 'TwinDesk Camera', slotMap: { 'phone-1': 0, 'phone-2': 1 } },
      phone: { phones: [phone1, phone2] },
    };

    render(stateWithTwoCameras);

    const picCard = pageBody.children[0];
    assert.ok(picCard, 'picCard exists');
    const previewArea = picCard.children[0];
    const emptyBox = previewArea.children[0];
    const grid = previewArea.children[1];

    assert.strictEqual(emptyBox.hidden, true, 'empty box hidden when cameras running');
    assert.strictEqual(grid.hidden, false, 'grid visible when cameras running');
    assert.strictEqual(grid.children.length, 2, '2 preview tiles rendered');

    const tile1 = grid.children[0];
    const tile2 = grid.children[1];

    assert.ok(tile1.title.includes('Android 1'), 'tile 1 labelled Android 1');
    assert.ok(tile1.title.includes('Pixel 8'), 'tile 1 has Pixel 8 hint');
    assert.ok(tile2.title.includes('Android 2'), 'tile 2 labelled Android 2');
    assert.ok(tile2.title.includes('Galaxy S24'), 'tile 2 has Galaxy S24 hint');

    // Previews dispatch via onCamPreview
    assert.ok(typeof camPreviewCallback === 'function', 'camPreviewCallback registered');
    const p1Buf = Buffer.from('preview-1');
    const p2Buf = Buffer.from('preview-2');

    camPreviewCallback(p1Buf, 501);
    const img1 = tile1.children[0];
    assert.ok(img1.src && img1.src.startsWith('blob:'), 'tile 1 updated with blob preview');

    camPreviewCallback(p2Buf, 502);
    const img2 = tile2.children[0];
    assert.ok(img2.src && img2.src.startsWith('blob:'), 'tile 2 updated with blob preview');

    // Virtual camera card slot behavior:
    // When driver reports fewer than 2 slots (e.g. on Windows, slots is null/undefined):
    // hide per-phone "Send to" select, show single "Camera source" row (Mac behavior)
    const vCard = pageBody.children[1];
    const sourceRow = vCard.children[1]; // [vTargetRow, sourceRow, vSendToRows, vRow]
    const vSendToRows = vCard.children[2];
    assert.strictEqual(sourceRow.label, 'Camera source', 'Camera source row exists in vCard');
    assert.strictEqual(sourceRow.hidden, false, 'Camera source row is shown when slots < 2');
    assert.strictEqual(vSendToRows.hidden, true, 'Send to per-phone container is hidden when slots < 2');

    // When driver reports >= 2 slots:
    render({
      ...stateWithTwoCameras,
      vcam: { ...stateWithTwoCameras.vcam, slots: ['TwinDesk Camera', 'TwinDesk Camera 2'] },
    });
    assert.strictEqual(sourceRow.hidden, true, 'Camera source row is hidden when slots >= 2');
    assert.strictEqual(vSendToRows.hidden, false, 'Send to per-phone container is shown when slots >= 2');
  });

  // Test 3: Virtual camera slots & frames routed only to assigned slot
  await t.test('Virtual camera slot assignment and frames routed only to assigned slot', async () => {
    const driver = fakeMultiSlotDriver();
    const cfg = { virtual: true, rotate: 0 };
    const vcam = new VirtualCam({
      driver,
      cfg: () => cfg,
      save: () => {},
      onChange: () => {},
      onReady: () => {},
      ui: () => ({ isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {} } }),
    });
    await vcam.check();
    await vcam.setOn(true);
    assert.strictEqual(vcam.ready, true);

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

    // Move wc2 to slot 0 ("one slot holds one phone" rule unseats wc1)
    vcam.setSlot(wc2, 0);
    assert.strictEqual(vcam.getSlot(wc2), 0, 'wc2 now has slot 0');
    assert.notStrictEqual(vcam.getSlot(wc1), 0, 'wc1 unseated from slot 0');

    // Frames only to assigned slot
    driver.writtenBySlot.clear();

    // wc2 frame goes to slot 0
    ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.writtenBySlot.get(0), 1, 'wc2 frame went to slot 0');
    assert.strictEqual(driver.writtenBySlot.get(1) || 0, 0, 'no frames on slot 1');

    // wc1 is unseated, its frame must be dropped
    ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.writtenBySlot.get(0), 1, 'unseated wc1 frame dropped');

    // Assign wc1 to slot 1
    vcam.setSlot(wc1, 1);
    assert.strictEqual(vcam.getSlot(wc1), 1, 'wc1 assigned to slot 1');

    // Now send frames from both
    ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
    ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.writtenBySlot.get(0), 2, 'slot 0 received wc2 frame');
    assert.strictEqual(driver.writtenBySlot.get(1), 1, 'slot 1 received wc1 frame');

    vcam.stop();
  });

  // Test 4: IPC wiring (phoneCamera, phoneListCameras, camera actions, phoneCloseView)
  await t.test('IPC wiring for phoneCamera, phoneListCameras, camera actions and phoneCloseView', async () => {
    let cameraTurnedOn = false;
    const settings = { camera: { on: true, rotate: 0 } };
    const driver = fakeMultiSlotDriver();
    const vcam = new VirtualCam({
      driver,
      cfg: () => settings.camera,
      save: () => {},
      onChange: () => {},
      onReady: () => {},
      ui: () => ({ isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {} } }),
    });
    await vcam.check();
    await vcam.setOn(true);

    const dummyViews = {
      views: new Map(),
      list() { return [...this.views.values()]; },
      openCamera(opts) {
        const v = { id: 77, kind: 'camera', facing: opts && opts.facing, win: { isDestroyed: () => false, isVisible: () => true, webContents: { id: 999, isDestroyed: () => false } } };
        this.views.set(77, v);
      },
      close(id) { this.views.delete(id); },
    };

    const ctx = {
      settings,
      phone: {
        active: { bridge: { listCameras: async () => [{ id: '0', facing: 'back' }] } },
        bridge: { listCameras: async () => [{ id: '0', facing: 'back' }] },
        closeView: (id) => dummyViews.close(id),
      },
      phoneViews: dummyViews,
      vcam,
      setCamera: (on) => { settings.camera.on = !!on; cameraTurnedOn = true; },
      state: { setup: { missing: [] } },
      save: () => {},
      push: () => {},
      buildState: () => ({}),
      checkFirewall: () => {},
      fixFirewall: () => {},
      setStartup: () => {},
    };

    setupIpc(ctx);

    // phoneCamera: open camera
    await ipcMain.invoke('phoneCamera', true, { facing: 'front' });
    assert.strictEqual(dummyViews.list().length, 1);
    assert.strictEqual(dummyViews.list()[0].facing, 'front');

    // phoneListCameras
    const cams = await ipcMain.invoke('phoneListCameras');
    assert.deepStrictEqual(cams, [{ id: '0', facing: 'back' }]);

    // camera: rotate
    await ipcMain.invoke('camera', { do: 'rotate' });
    assert.strictEqual(settings.camera.rotate, 90);

    // camera: slot
    await ipcMain.invoke('camera', { do: 'slot', phoneId: 'phone-test', slot: 1 });
    assert.strictEqual(vcam.getSlot('phone-test'), 1);

    // phoneCloseView
    await ipcMain.invoke('phoneCloseView', 77);
    assert.strictEqual(dummyViews.list().length, 0);

    vcam.stop();
  });

  // Test 5: Per-phone PhoneViews cameraState (wcId, shown, virtualActive, slot, viewId)
  await t.test('PhoneViews cameraState exposes wcId, shown, virtualActive, slot and viewId', () => {
    const settings = { camera: { on: true } };
    const fakeServer = Object.assign(new EventEmitter(), { current: { name: 'Pixel 8' }, id: 'phone-1' });
    const fakeBridge = Object.assign(new EventEmitter(), {
      serial: 'mock-serial-1',
      adb: {
        push: async () => ({ code: 0 }),
        forward: async () => 1234,
        shell: async () => ({ code: 0, out: '' }),
        spawnShell: () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} }),
      },
      sessionOpts: () => ({}),
      _tellPhone: () => {},
    });
    const views = new PhoneViews({ bridge: fakeBridge, phone: {}, getSettings: () => settings, server: fakeServer, fileSend: {} });

    const driver = fakeMultiSlotDriver();
    const vcam = new VirtualCam({
      driver,
      cfg: () => settings.camera,
      save: () => {},
      onChange: () => {},
      onReady: () => {},
      ui: () => ({ isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {} } }),
    });
    views.vcam = vcam;

    views.openCamera({ facing: 'back' });
    const st = views.cameraState();
    assert.strictEqual(st.on, true, 'camera is on');
    assert.strictEqual(st.facing, 'back', 'facing is back');
    assert.ok(typeof st.wcId === 'number' && st.wcId > 0, 'exposes wcId');
    assert.ok(typeof st.viewId === 'number' && st.viewId > 0, 'exposes viewId');
    assert.strictEqual(st.virtual, false, 'vcam not yet setOn');

    // Close view
    views.close(st.viewId);
    assert.strictEqual(views.cameraState().on, false, 'camera is closed');
  });
});
