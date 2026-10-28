// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Where a running camera's picture goes (Windows, Mac and Linux). Its window (the other computer's
// camera, or a phone's) is hidden and sends the picture on (shared/vcam-feed.js): to the Camera tab
// ('vcam:preview', a small JPEG, passed to ui()), and while Virtual camera is on to a camera every
// app on this computer can pick ("TwinDesk Camera": NV12, 1280×720, on 'vcam:frame', to the
// driver's feed process; black without frames). The windows say hello and are told what to do
// ('vcam:set' {vcam, rotate}). Virtual camera is off until turned on; turning it on installs the
// camera the first time (each platform's driver: windows/vcam.js, linux/vcam.js, mac/vcam.js).
// Camera › Rotate (settings.camera.rotate, quarter turns) turns the picture everywhere.
//
// driver: {name, always?, check() → {supported, installed, message}, install(say), remove(), feed(onExit) → ChildProcess}
//   targets?: [{value, label}], cameras it can feed (the Mac: TwinDesk Camera or OBS Virtual Camera),
//   chosen in settings.camera.target and passed to check, install, remove and feed as their last
//   argument; nameOf(target), removable(target).
//   say(text): what installing waits for now (the Mac: the person allowing it in System Settings).
//   always: the feed runs all the while it's on (Linux: an apps sees the camera only while
//   something writes to it), not only while frames come.
// cfg() → settings.camera; save(); onChange(); onReady(ready): it's ready (on and installed) or not;
// ui() → the main window (the tab's picture goes there).
'use strict';

const FRAME = 1280 * 720 * 3 / 2;
const IDLE_MS = 5000; // no frames this long: the feed process goes (it starts again with the next one)
const LIVE_MS = 2000;

class VirtualCam {
  constructor({ driver, cfg, save, onChange, onReady, ui = () => null }) {
    Object.assign(this, { driver, cfg, save, onChange, onReady, ui });
    this.state = { checked: false, supported: !!driver, installed: false, busy: '', message: '' };
    this.proc = null;
    this.procs = new Map(); // slot index -> ChildProcess
    this.blocked = false; // the feed's pipe is full: frames drop until it drains
    this.blockedSlots = new Set();
    this.lastFrame = 0;
    this.idle = null;
    this.idles = new Map();
    this.wasReady = false;
    this.sources = new Set(); // the camera windows' webContents
    this.activeSource = null; // in multi-phone mesh, the camera window feeding the virtual camera
    this.slotMap = new Map(); // wc or wcId -> slot index (0..3) or null for 'off'
    this.phoneSlotMap = new Map(); // phoneId -> slot index (0..3) or null
    this.lastPreview = 0;
    const { ipcMain } = require('electron');
    ipcMain.on('vcam:frame', (e, buf) => {
      const sender = e.sender;
      const assigned = this.getSlot(sender);
      if (assigned !== null && assigned !== undefined) {
        this.frame(buf, assigned);
        return;
      }
      if (this._isExplicitlyOff(sender)) return;
      if (this.activeSource && sender !== this.activeSource) return;
      this.frame(buf, 0);
    });
    ipcMain.on('vcam:hello', (e) => {
      const wc = e.sender;
      this.sources.add(wc);
      if (!this.activeSource) this.activeSource = wc;
      if (wc && typeof wc.once === 'function') {
        wc.once('destroyed', () => {
          this.sources.delete(wc);
          this.slotMap.delete(wc);
          if (wc.id) this.slotMap.delete(wc.id);
          if (this.activeSource === wc) {
            this.activeSource = this.sources.values().next().value || null;
            this._tellAll();
            this.onChange();
          }
        });
      }
      this._tell(wc);
    });
    ipcMain.on('vcam:preview', (e, buf) => {
      const w = this.ui();
      if (!buf || buf.byteLength > 2e6) return;
      const was = this.lastPreview;
      this.lastPreview = Date.now();
      if (this.lastPreview - was > LIVE_MS) this.onChange(); // the tab's picture came
      clearTimeout(this.pictureTimer);
      this.pictureTimer = setTimeout(() => this.onChange(), LIVE_MS + 100); // …or stopped
      const senderId = e && e.sender ? e.sender.id : undefined;
      if (w && !w.isDestroyed() && w.isVisible()) w.webContents.send('vcam:preview', buf, senderId);
    });
  }

  get rotate() {
    const r = this.cfg().rotate;
    return [0, 90, 180, 270].includes(r) ? r : 0;
  }

  // Camera › Rotate: a quarter turn clockwise.
  turn() {
    this.cfg().rotate = (this.rotate + 90) % 360;
    this.save();
    this._tellAll();
    this.onChange();
  }

  setActiveSource(wc) {
    if (this.activeSource === wc) return;
    this.activeSource = wc;
    this._tellAll();
    this.onChange();
  }

  _normalizeSlot(s) {
    if (s === 'off' || s === '' || s === null || s === undefined || s === -1) return null;
    if (typeof s === 'number' && s >= 0 && s < 4) return s;
    if (typeof s === 'string') {
      const num = parseInt(s, 10);
      if (!isNaN(num) && num >= 0 && num < 4) return num;
      if (this.driver && Array.isArray(this.driver.slots)) {
        const idx = this.driver.slots.indexOf(s);
        if (idx !== -1) return idx;
      }
      const match = s.match(/(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n >= 1 && n <= 4) return n - 1;
      }
      if (s.toLowerCase().includes('twindesk camera')) return 0;
    }
    return null;
  }

  setSlot(source, slot) {
    const s = this._normalizeSlot(slot);
    // Enforce "one slot holds one phone": unassign any other entity from this slot
    if (s !== null) {
      for (const [k, v] of this.slotMap.entries()) {
        if (v === s && k !== source && (!source || k !== source.id)) {
          this.slotMap.set(k, null);
        }
      }
      for (const [k, v] of this.phoneSlotMap.entries()) {
        if (v === s && k !== source) {
          this.phoneSlotMap.set(k, null);
        }
      }
    }
    if (typeof source === 'string') {
      this.phoneSlotMap.set(source, s);
    } else if (typeof source === 'number') {
      this.slotMap.set(source, s);
    } else if (source) {
      this.slotMap.set(source, s);
      if (source.id) this.slotMap.set(source.id, s);
    }
    this._tellAll();
    this._sync();
    this.onChange();
  }

  getSlot(source) {
    if (source == null) return null;
    if (this.slotMap.has(source)) return this.slotMap.get(source);
    if (typeof source === 'object' && source.id && this.slotMap.has(source.id)) {
      return this.slotMap.get(source.id);
    }
    if (typeof source === 'string' && this.phoneSlotMap.has(source)) {
      return this.phoneSlotMap.get(source);
    }
    return null;
  }

  _isExplicitlyOff(source) {
    if (source == null) return false;
    if (this.slotMap.has(source)) return this.slotMap.get(source) === null;
    if (typeof source === 'object' && source.id && this.slotMap.has(source.id)) {
      return this.slotMap.get(source.id) === null;
    }
    if (typeof source === 'string' && this.phoneSlotMap.has(source)) {
      return this.phoneSlotMap.get(source) === null;
    }
    return false;
  }

  syncPhoneSlot(phoneId, wc) {
    if (!phoneId || !wc) return;
    const s = this.phoneSlotMap.get(phoneId);
    if (s !== undefined) {
      this.slotMap.set(wc, s);
      if (wc.id) this.slotMap.set(wc.id, s);
      this._tell(wc);
    }
  }

  _isFeeding(wc) {
    if (!this.ready) return false;
    const hasExplicit = this.slotMap.has(wc) || (wc && this.slotMap.has(wc.id));
    if (hasExplicit) {
      const s = this.getSlot(wc);
      return s !== null && s !== undefined;
    }
    return !this.activeSource || this.activeSource === wc;
  }

  _tell(wc) {
    if (wc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed()) && typeof wc.send === 'function') {
      const active = this._isFeeding(wc);
      wc.send('vcam:set', { vcam: active, rotate: this.rotate });
    }
  }

  _tellAll() {
    for (const wc of this.sources) this._tell(wc);
  }

  // The camera it feeds (driver.targets), the first unless another is chosen.
  get target() {
    const t = this.driver && this.driver.targets;
    if (!t || !t.length) return undefined;
    return t.some((x) => x.value === this.cfg().target) ? this.cfg().target : t[0].value;
  }

  // Camera › Virtual camera › Send to: another camera (it's checked, and fed from the next frame).
  async setTarget(target) {
    const t = this.driver && this.driver.targets;
    if (!t || !t.some((x) => x.value === target) || target === this.target || this.state.busy) return;
    this.cfg().target = target;
    this.save();
    this._stopFeed();
    this._set({ installed: false, message: '' });
    await this.check();
  }

  get on() {
    return this.cfg().virtual === true;
  }

  // On and installed: Show feeds the camera.
  get ready() {
    return this.on && this.state.installed;
  }

  async check() {
    if (!this.driver) return this._set({ checked: true, supported: false, message: 'Not on this computer' });
    try {
      const r = await this.driver.check(this.target);
      this._set({ checked: true, supported: r.supported !== false, installed: !!r.installed, message: r.message || '' });
    } catch (e) {
      this._set({ checked: true, message: 'Couldn’t check the virtual camera: ' + e.message });
    }
    if (this.on && this.state.supported && !this.state.installed && !this.state.busy) await this.install();
  }

  async setOn(on) {
    this.cfg().virtual = !!on;
    this.save();
    if (on && !this.state.checked) return this.check();
    if (on && this.state.supported && !this.state.installed) return this.install();
    this._set({ message: on ? this.state.message : '' });
  }

  async install() {
    if (this.state.busy || !this.driver) return;
    this._set({ busy: 'install', message: '' });
    try {
      await this.driver.install((text) => this._set({ message: String(text || '') }), this.target);
      const r = await this.driver.check(this.target);
      this.state.installed = !!r.installed;
      this.state.message = r.installed ? '' : (r.message || 'It didn’t install');
    } catch (e) {
      this.state.message = e.message;
    }
    this._set({ busy: '' });
  }

  // Camera › Remove: the camera goes from this computer (the switch goes off).
  async remove() {
    if (this.state.busy || !this.driver) return;
    this.cfg().virtual = false;
    this.save();
    this._set({ busy: 'remove', message: '' });
    this._stopFeed();
    try {
      await this.driver.remove(this.target);
      this.state.installed = false;
    } catch (e) {
      this.state.message = 'Couldn’t remove it: ' + e.message;
    }
    try {
      const r = await this.driver.check(this.target);
      this.state.installed = !!r.installed;
    } catch {}
    this._set({ busy: '' });
  }

  frame(buf, slot = 0) {
    if (!this.ready || !buf || buf.byteLength !== FRAME) return;
    const was = this.lastFrame;
    this.lastFrame = Date.now();
    // The tab's "live" comes and goes with the frames.
    if (this.lastFrame - was > LIVE_MS) this.onChange();
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.onChange(), LIVE_MS + 100);
    this._startFeed(slot);
    clearTimeout(this.idles.get(slot));
    if (!this.driver.always) {
      this.idles.set(slot, setTimeout(() => this._stopFeed(slot), IDLE_MS));
    }
    const proc = this.procs.get(slot) || (slot === 0 ? this.proc : null);
    if (!proc || this.blockedSlots.has(slot)) return;
    if (!proc.stdin.write(Buffer.from(buf))) {
      this.blockedSlots.add(slot);
      if (slot === 0) this.blocked = true;
      proc.stdin.once('drain', () => {
        this.blockedSlots.delete(slot);
        if (slot === 0) this.blocked = false;
      });
    }
  }

  _startFeed(slot = 0) {
    if (this.procs.has(slot) || !this.ready) return;
    const arg = (this.driver && this.driver.slots) ? slot : (this.target !== undefined ? this.target : slot);
    const p = this.driver.feed(() => {
      if (this.procs.get(slot) !== p) return;
      this.procs.delete(slot);
      this.blockedSlots.delete(slot);
      if (slot === 0) {
        this.proc = null;
        this.blocked = false;
      }
      // Linux: it runs all the while it's on (again a moment after it stops).
      if (this.driver.always) setTimeout(() => this._sync(), 2000);
    }, arg);
    if (p) {
      this.procs.set(slot, p);
      if (slot === 0) this.proc = p;
    }
  }

  _stopFeed(slot) {
    if (slot !== undefined) {
      clearTimeout(this.idles.get(slot));
      this.idles.delete(slot);
      const p = this.procs.get(slot);
      this.procs.delete(slot);
      this.blockedSlots.delete(slot);
      if (slot === 0) {
        clearTimeout(this.idle);
        this.proc = null;
        this.blocked = false;
      }
      if (p) {
        try { p.stdin.end(); } catch {}
        setTimeout(() => { try { p.kill(); } catch {} }, 1000);
      }
      return;
    }
    clearTimeout(this.idle);
    for (const t of this.idles.values()) clearTimeout(t);
    this.idles.clear();
    const all = [...this.procs.values()];
    this.procs.clear();
    this.blockedSlots.clear();
    this.proc = null;
    this.blocked = false;
    for (const p of all) {
      if (p) {
        try { p.stdin.end(); } catch {}
        setTimeout(() => { try { p.kill(); } catch {} }, 1000);
      }
    }
  }

  // The camera's windows feed the camera while it's ready; Linux's feed runs all that while.
  _sync() {
    const ready = this.ready;
    if (this.driver && this.driver.always) {
      if (ready) {
        this._startFeed(0);
        for (const slot of this.slotMap.values()) {
          if (slot !== null && typeof slot === 'number') this._startFeed(slot);
        }
        for (const slot of this.phoneSlotMap.values()) {
          if (slot !== null && typeof slot === 'number') this._startFeed(slot);
        }
      } else {
        this._stopFeed();
      }
    } else if (!ready) {
      this._stopFeed();
    }
    if (ready !== this.wasReady) {
      this.wasReady = ready;
      this._tellAll();
      if (this.onReady) this.onReady(ready);
    }
  }

  _set(p) {
    Object.assign(this.state, p);
    this._sync();
    this.onChange();
  }

  // For the Camera tab (state.vcam).
  view() {
    const slotMapObj = {};
    for (const [k, v] of this.phoneSlotMap.entries()) {
      slotMapObj[k] = v;
    }
    for (const [k, v] of this.slotMap.entries()) {
      if (typeof k === 'number' || typeof k === 'string') slotMapObj[k] = v;
      else if (k && typeof k.id === 'number') slotMapObj[k.id] = v;
    }
    return {
      ...this.state,
      on: this.on,
      ready: this.ready,
      name: !this.driver ? '' : this.driver.nameOf ? this.driver.nameOf(this.target) : this.driver.name,
      targets: (this.driver && this.driver.targets) || null,
      target: this.target || '',
      slots: (this.driver && this.driver.slots) || null,
      slotMap: slotMapObj,
      removable: !this.driver || !this.driver.removable || this.driver.removable(this.target),
      live: this.ready && Date.now() - this.lastFrame < LIVE_MS, // the virtual camera gets frames
      picture: Date.now() - this.lastPreview < LIVE_MS, // the tab gets its picture
      rotate: this.rotate,
      activeSourceId: this.activeSource && typeof this.activeSource.id === 'number' ? this.activeSource.id : null,
    };
  }

  stop() {
    clearTimeout(this.pictureTimer);
    this._stopFeed();
  }
}

module.exports = { VirtualCam, FRAME };
