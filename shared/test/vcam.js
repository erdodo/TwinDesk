// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/vcam.js: Camera › Virtual camera with a stand-in driver — installed when turned on,
// the camera's windows told when it's ready, frames to the feed, failures said in the tab.
'use strict';

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

// No Electron here: ipcMain is an EventEmitter the test sends frames through.
const ipcMain = new EventEmitter();
const load = Module._load;
Module._load = function (req, ...rest) {
  return req === 'electron' ? { ipcMain } : load.call(this, req, ...rest);
};
const { VirtualCam, FRAME } = require('../vcam.js');

function fakeDriver({ installed = false, fail = '' } = {}) {
  const d = {
    name: 'TwinDesk Camera',
    installs: 0,
    written: 0,
    feeds: 0,
    installed,
    async check() { return { supported: true, installed: d.installed }; },
    async install(say) {
      d.installs++;
      say('Allow it');
      if (fail) throw new Error(fail);
      d.installed = true;
    },
    async remove() { d.installed = false; },
    feed(onExit) {
      d.feeds++;
      const p = new EventEmitter();
      p.stdin = Object.assign(new EventEmitter(), { write: () => { d.written++; return true; }, end: () => onExit() });
      p.kill = () => {};
      return p;
    },
  };
  return d;
}

(async () => {
  // Off: nothing installed, frames dropped.
  {
    const driver = fakeDriver();
    const cfg = {};
    const readies = [];
    const v = new VirtualCam({ driver, cfg: () => cfg, save: () => {}, onChange: () => {}, onReady: (r) => readies.push(r) });
    await v.check();
    assert.strictEqual(driver.installs, 0);
    assert.strictEqual(v.view().ready, false);
    ipcMain.emit('vcam:frame', {}, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.written, 0);

    // On: installs, then ready (the windows reopen), and frames reach the feed.
    await v.setOn(true);
    assert.strictEqual(driver.installs, 1);
    assert.strictEqual(cfg.virtual, true);
    assert.deepStrictEqual(readies, [true]);
    const view = v.view();
    assert.strictEqual(view.ready, true);
    assert.strictEqual(view.message, '', 'the approval text goes once installed');
    ipcMain.emit('vcam:frame', {}, new ArrayBuffer(FRAME));
    ipcMain.emit('vcam:frame', {}, new ArrayBuffer(FRAME));
    assert.strictEqual(driver.feeds, 1, 'one feed process for many frames');
    assert.strictEqual(driver.written, 2);
    assert.strictEqual(v.view().live, true);
    // A frame of the wrong size is dropped.
    ipcMain.emit('vcam:frame', {}, new ArrayBuffer(10));
    assert.strictEqual(driver.written, 2);

    // Off again: not ready (the windows reopen as windows), no install asked for.
    await v.setOn(false);
    assert.deepStrictEqual(readies, [true, false]);
    assert.strictEqual(v.view().installed, true);
    // On again: no second install.
    await v.setOn(true);
    assert.strictEqual(driver.installs, 1);

    // Remove: the switch goes off and the camera goes.
    await v.remove();
    assert.strictEqual(cfg.virtual, false);
    assert.strictEqual(v.view().installed, false);
    v.stop();
    ipcMain.removeAllListeners('vcam:frame');
  }

  // Already on at start, not installed: installs at the check.
  {
    const driver = fakeDriver();
    const cfg = { virtual: true };
    const v = new VirtualCam({ driver, cfg: () => cfg, save: () => {}, onChange: () => {} });
    await v.check();
    assert.strictEqual(driver.installs, 1);
    assert.strictEqual(v.ready, true);
    v.stop();
    ipcMain.removeAllListeners('vcam:frame');
  }

  // A failed install: the switch stays on, not ready, the reason in the tab.
  {
    const driver = fakeDriver({ fail: 'The administrator prompt was declined' });
    const cfg = {};
    const v = new VirtualCam({ driver, cfg: () => cfg, save: () => {}, onChange: () => {} });
    await v.check();
    await v.setOn(true);
    assert.strictEqual(v.view().on, true);
    assert.strictEqual(v.view().ready, false);
    assert.strictEqual(v.view().message, 'The administrator prompt was declined');
    ipcMain.removeAllListeners('vcam:frame');
  }

  // Targets (the Mac: TwinDesk Camera or OBS Virtual Camera): each checked, removed and fed as itself.
  {
    const seen = [];
    const driver = Object.assign(fakeDriver(), {
      targets: [{ value: 'twindesk', label: 'TwinDesk Camera' }, { value: 'obs', label: 'OBS Virtual Camera' }],
      nameOf: (t) => (t === 'obs' ? 'OBS Virtual Camera' : 'TwinDesk Camera'),
      removable: (t) => t !== 'obs',
      async check(t) { seen.push(t); return t === 'obs' ? { supported: true, installed: true } : { supported: false, message: 'Not in this build' }; },
    });
    const feed = driver.feed;
    driver.feed = (onExit, t) => { seen.push('feed:' + t); return feed(onExit); };
    const cfg = { virtual: true, target: 'nope' };
    const v = new VirtualCam({ driver, cfg: () => cfg, save: () => {}, onChange: () => {} });
    await v.check();
    assert.strictEqual(v.target, 'twindesk');
    assert.strictEqual(v.view().supported, false);
    assert.strictEqual(v.view().ready, false);
    await v.setTarget('obs');
    assert.strictEqual(cfg.target, 'obs');
    assert.deepStrictEqual(v.view().name, 'OBS Virtual Camera');
    assert.strictEqual(v.view().removable, false);
    assert.strictEqual(v.view().ready, true);
    ipcMain.emit('vcam:frame', {}, new ArrayBuffer(FRAME));
    assert.deepStrictEqual(seen, ['twindesk', 'obs', 'feed:obs']);
    await v.setTarget('elsewhere'); // not one of them: unchanged
    assert.strictEqual(cfg.target, 'obs');
    v.stop();
    ipcMain.removeAllListeners('vcam:frame');
  }

  // No driver (a platform without one): not supported.
  {
    const v = new VirtualCam({ driver: null, cfg: () => ({}), save: () => {}, onChange: () => {} });
    await v.check();
    assert.strictEqual(v.view().supported, false);
    ipcMain.removeAllListeners('vcam:frame');
  }

  // Preview forwarding to ui with sender webContents id (backward-compatible)
  {
    const sent = [];
    const uiWin = {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: {
        send: (ev, ...args) => {
          if (ev === 'vcam:preview') sent.push(args);
        },
      },
    };
    const v = new VirtualCam({ driver: null, cfg: () => ({}), save: () => {}, onChange: () => {}, ui: () => uiWin });
    const s1 = { id: 101 };
    const s2 = { id: 102 };
    const buf1 = Buffer.from('frame1');
    const buf2 = Buffer.from('frame2');
    ipcMain.emit('vcam:preview', { sender: s1 }, buf1);
    ipcMain.emit('vcam:preview', { sender: s2 }, buf2);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0][0], buf1);
    assert.strictEqual(sent[0][1], 101);
    assert.strictEqual(sent[1][0], buf2);
    assert.strictEqual(sent[1][1], 102);

    // Single-arg listener (one-to-one legacy caller)
    let legacyBuf = null;
    const legacyListener = (b) => { legacyBuf = b; };
    legacyListener(...sent[0]);
    assert.strictEqual(legacyBuf, buf1);

    v.stop();
    ipcMain.removeAllListeners('vcam:preview');
  }

  console.log('vcam: passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
