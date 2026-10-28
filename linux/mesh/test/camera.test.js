// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Camera sharing in Mesh: multi-phone camera windows, per-phone camera state,
// and virtual camera active source switching.
// Run with: node linux/mesh/test/camera.test.js
'use strict';

const assert = require('assert');
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

const { VirtualCam, FRAME } = require('../../../shared/vcam.js');
const { PhoneLink } = require('../phone-link.js');
const { Phone } = require('../phone.js');
const { PhoneBridge } = require('../phone-bridge.js');
const { PhoneViews } = require('../../phoneview.js');
const { PhoneSet } = require('../phones.js');
const setupIpc = require('../ipc.js');

function fakeDriver() {
  const d = {
    name: 'TwinDesk Camera',
    installs: 0,
    written: 0,
    feeds: 0,
    installed: true,
    async check() { return { supported: true, installed: true }; },
    async install() { d.installed = true; },
    async remove() { d.installed = false; },
    feed(onExit) {
      d.feeds++;
      const p = new EventEmitter();
      p.stdin = Object.assign(new EventEmitter(), {
        write: () => { d.written++; return true; },
        end: () => onExit(),
      });
      p.kill = () => {};
      return p;
    },
  };
  return d;
}

(async () => {
  // Test 1: VirtualCam multi-phone active source routing and failover
  {
    console.log('Test 1: VirtualCam multi-phone active source');
    const driver = fakeDriver();
    const cfg = { virtual: true, rotate: 0 };
    let changes = 0;
    const vcam = new VirtualCam({
      driver,
      cfg: () => cfg,
      save: () => {},
      onChange: () => { changes++; },
      onReady: () => {},
      ui: () => ({ isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {} } }),
    });
    await vcam.check();
    await vcam.setOn(true);
    assert.strictEqual(vcam.ready, true);

    // Two camera windows register
    const wc1 = new EventEmitter();
    wc1.id = 101;
    wc1.isDestroyed = () => false;
    const wc1Messages = [];
    wc1.send = (ev, msg) => wc1Messages.push({ ev, msg });

    const wc2 = new EventEmitter();
    wc2.id = 102;
    wc2.isDestroyed = () => false;
    const wc2Messages = [];
    wc2.send = (ev, msg) => wc2Messages.push({ ev, msg });

    ipcMain.emit('vcam:hello', { sender: wc1 });
    assert.strictEqual(vcam.activeSource, wc1, 'first source is active by default');
    assert.strictEqual(wc1Messages[0].msg.vcam, true, 'active source gets vcam: true');

    ipcMain.emit('vcam:hello', { sender: wc2 });
    assert.strictEqual(vcam.activeSource, wc1, 'active source unchanged when second joins');
    assert.strictEqual(wc2Messages[0].msg.vcam, false, 'second source gets vcam: false');

    // Frames from wc2 are dropped; frames from wc1 are accepted
    ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.written, 0, 'inactive source frames dropped');

    ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.written, 1, 'active source frames passed to driver');

    // Switch active source to wc2
    vcam.setActiveSource(wc2);
    assert.strictEqual(vcam.activeSource, wc2);
    assert.strictEqual(wc2Messages[wc2Messages.length - 1].msg.vcam, true);
    assert.strictEqual(wc1Messages[wc1Messages.length - 1].msg.vcam, false);

    // Now wc1 dropped, wc2 accepted
    ipcMain.emit('vcam:frame', { sender: wc1 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.written, 1);
    ipcMain.emit('vcam:frame', { sender: wc2 }, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.written, 2);

    // wc2 destroyed: wc1 becomes active again
    wc2.emit('destroyed');
    assert.strictEqual(vcam.activeSource, wc1, 'fallback to next available source');
    assert.strictEqual(wc1Messages[wc1Messages.length - 1].msg.vcam, true);

    vcam.stop();
  }

  // Test 2: Multi-phone PhoneSet and cameraState
  {
    console.log('Test 2: PhoneSet and per-phone camera state');
    const settings = { camera: { on: true, rotate: 0 }, phone: {}, mount: { on: false }, audio: { receive: false } };
    const driver = fakeDriver();
    const vcam = new VirtualCam({
      driver,
      cfg: () => settings.camera,
      save: () => {},
      onChange: () => {},
      onReady: () => {},
    });
    await vcam.check();
    await vcam.setOn(true);

    const bus = new EventEmitter();
    bus.connectedIds = () => ['phone-1', 'phone-2'];
    const hub = { bus, selectedId: 'phone-1', sessions: new Map() };
    const rawServer = new EventEmitter();
    rawServer.clients = new Map([
      ['phone-1', { deviceId: 'phone-1', os: 'android', name: 'Phone One', authSeq: 1 }],
      ['phone-2', { deviceId: 'phone-2', os: 'android', name: 'Phone Two', authSeq: 2 }],
    ]);

    const pl = new PhoneLink(hub, rawServer);
    const set = new PhoneSet({
      hub,
      link: pl,
      raw: rawServer,
      discovery: { list: () => [], get: () => null },
      pairing: { list: () => [] },
      make: (scoped) => {
        const ph = new Phone({ server: scoped, raw: rawServer, discovery: { list: () => [], get: () => null }, pairing: { list: () => [] } });
        const bridge = new PhoneBridge({ server: scoped, phone: ph, getSettings: () => settings, clipboard: {}, adb: { available: true, wake: () => {} } });
        bridge.serial = 'fake-serial-' + scoped.id;
        bridge.state = 'ready';
        const views = new PhoneViews({ bridge, phone: ph, getSettings: () => settings, server: scoped, fileSend: { sendBatch: () => {} } });
        views.vcam = vcam;
        ph.bridge = bridge;
        return { phone: ph, bridge, views };
      },
    });

    // Connect phone 1 and phone 2
    rawServer.emit('client', rawServer.clients.get('phone-1'));
    rawServer.emit('client', rawServer.clients.get('phone-2'));

    const u1 = set.unit('phone-1');
    const u2 = set.unit('phone-2');
    assert.ok(u1 && u2, 'both units exist');

    // Open camera on phone 1
    u1.views.openCamera({ facing: 'back' });
    const c1 = u1.views.cameraState();
    assert.strictEqual(c1.on, true);
    assert.strictEqual(c1.facing, 'back');
    assert.strictEqual(c1.virtualActive, true, 'phone 1 is first and active');

    // Open camera on phone 2
    u2.views.openCamera({ facing: 'front' });
    const c2 = u2.views.cameraState();
    assert.strictEqual(c2.on, true);
    assert.strictEqual(c2.facing, 'front');

    // Test closeView across units
    const v2 = [...u2.views.views.values()][0];
    assert.ok(v2);
    set.closeView(v2.id);
    assert.strictEqual(u2.views.cameraState().on, false, 'phone 2 camera closed via phoneSet.closeView');
    assert.strictEqual(u1.views.cameraState().on, true, 'phone 1 camera remains open');

    vcam.stop();
  }

  // Test 3: Mesh IPC wiring for camera and active source
  {
    console.log('Test 3: Mesh IPC wiring');
    let camOn = true;
    const settings = { camera: { on: true, rotate: 0 }, phone: {}, mount: { on: false }, audio: { receive: false } };
    const driver = fakeDriver();
    const vcam = new VirtualCam({
      driver,
      cfg: () => settings.camera,
      save: () => {},
      onChange: () => {},
      onReady: () => {},
    });
    await vcam.check();
    await vcam.setOn(true);

    let cameraTurnedOn = false;
    const setCamera = (on) => {
      camOn = !!on;
      settings.camera.on = camOn;
      cameraTurnedOn = true;
    };

    const dummyViews = {
      views: new Map(),
      list() { return [...this.views.values()]; },
      openCamera(opts) {
        const v = { id: 42, kind: 'camera', facing: opts && opts.facing, win: { isDestroyed: () => false, webContents: { id: 777, isDestroyed: () => false } } };
        this.views.set(42, v);
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
      setCamera,
      buildState: () => ({ setup: { missing: [] } }),
      save: () => {},
      push: () => {},
    };

    setupIpc(ctx);

    // Invoke phoneCamera
    await ipcMain.invoke('phoneCamera', true, { facing: 'front' });
    assert.strictEqual(dummyViews.list().length, 1);
    assert.strictEqual(dummyViews.list()[0].facing, 'front');

    // List cameras
    const cams = await ipcMain.invoke('phoneListCameras');
    assert.deepStrictEqual(cams, [{ id: '0', facing: 'back' }]);

    // Rotate camera
    await ipcMain.invoke('camera', { do: 'rotate' });
    assert.strictEqual(settings.camera.rotate, 90);

    // Close view
    await ipcMain.invoke('phoneCloseView', 42);
    assert.strictEqual(dummyViews.list().length, 0);

    vcam.stop();
  }

  console.log('All camera tests passed!');
  process.exit(0);
})().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
