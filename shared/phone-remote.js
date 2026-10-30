// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The phone as this computer's remote (Windows, Mac and Linux): its Remote page (a touchpad, a
// keyboard, a gamepad whose buttons are keys) moves this computer's pointer, clicks, scrolls and
// types. Relative input (remote.*) goes straight to the helper as k.* events, while the Remote tab's
// switch is on (settings.remote.allow, on until turned off) and this computer's own mouse is at home
// (not driving the phone or another computer). When it isn't taken, the phone is told why
// (remote.state {allowed, why}), and the Remote tab says it too.
// Real gamepad (settings.remote.pad, off until turned on): the gamepad page's sticks, triggers and
// buttons as a real controller here instead of keys (remote.pad; remote.state {pad: true} while it's
// taken). Its driver (windows/gamepad.js, linux/gamepad.js) is loaded only when it's turned on and
// installs what it needs the first time; its feed process runs only while the phone is connected.
//
// server: the phone's session (on('t:<type>'), on('closed'), current, sendToClient);
// helper: helper.js; getSettings(); atHome(): this computer's mouse is its own; onChange();
// loadPad() → the pad driver {check() → {supported, installed, message}, install(), feed(onExit) →
// ChildProcess}, or none where there's no way (padNote says why); save().
'use strict';

const P = require('./protocol.js');

const T = P.T;
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const num = (v, max) => Math.max(-max, Math.min(max, Number(v) || 0));
const BUTTONS = new Set(Object.values(P.BUTTON));
const CODE = /^[A-Za-z0-9]{1,32}$/; // KeyboardEvent.code names (KeyA, ArrowLeft, MediaPlayPause…)
const USING_MS = 3000; // input this recent: "in use now"

// remote.pad -> the feed's 12 bytes: u16 buttons, i16 lx ly rx ry (y down), u8 lt rt, little-endian.
function padBytes(m) {
  const b = Buffer.alloc(12);
  const axis = (v) => Math.round(Math.max(-1, Math.min(1, Number(v) || 0)) * 32767);
  const trigger = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  b.writeUInt16LE((Number(m.b) >>> 0) & 0x3fff, 0);
  b.writeInt16LE(axis(m.lx), 2);
  b.writeInt16LE(axis(m.ly), 4);
  b.writeInt16LE(axis(m.rx), 6);
  b.writeInt16LE(axis(m.ry), 8);
  b[10] = trigger(m.lt);
  b[11] = trigger(m.rt);
  return b;
}
const PAD_ZERO = padBytes({});

class PhoneRemote {
  constructor({ server, helper, getSettings, atHome, onChange = () => {}, loadPad = null, padNote = '', save = () => {} }) {
    Object.assign(this, { server, helper, getSettings, atHome, onChange, loadPad, padNote, save });
    this.pad = null; // the driver, once Real gamepad was turned on
    this.padProc = null; // its feed process (single-phone / backward-compat)
    this.padBusy = ''; // 'Checking…', 'Installing…'
    this.padMessage = ''; // why it isn't working
    this.padSupported = !!loadPad;
    this.held = false; // keys or buttons the phone may still hold down here
    this.refusedAt = 0;
    this.lastInput = 0;
    this.opened = false; // the phone's Remote page is open (it said hello)
    this.canType = false; // the helper types text as it is (its keyLayout says type: true): remote.text
    this._phones = new Map(); // phoneId -> { id, name, opened, lastInput, held, slot, padProc }
    this._slots = new Map(); // slotNumber (1..4) -> phoneId

    const on = (t, fn) => server.on(`t:${t}`, (m, ctx) => {
      const phone = this._phoneOf(m, ctx);
      if (!phone) return;
      const msg = m || {};
      if (!msg.phoneId) msg.phoneId = phone.deviceId || phone.id;
      fn(msg, phone);
    });

    on(T.REMOTE_HELLO, (m, phone) => {
      const ph = this._ensurePhone(phone);
      ph.opened = true;
      this.opened = true;
      if (this.padOn) this._padStart(phone);
      this._state(phone);
      this._askType();
      this.onChange();
    });

    // smooth: the helper eases the move out over about a frame instead of jumping (Smoother.cs).
    on(T.REMOTE_MOVE, (m, phone) => this._ev({ t: T.K_MOVE, dx: num(m.dx, 4000), dy: num(m.dy, 4000), smooth: m.smooth === true }, phone));
    on(T.REMOTE_DOWN, (m, phone) => BUTTONS.has(m.b) && this._ev({ t: T.K_DOWN, b: m.b }, phone));
    on(T.REMOTE_UP, (m, phone) => BUTTONS.has(m.b) && this._ev({ t: T.K_UP, b: m.b }, phone));
    on(T.REMOTE_WHEEL, (m, phone) => this._ev({ t: T.K_WHEEL, dx: num(m.dx, 4000), dy: num(m.dy, 4000), mode: 'pixel' }, phone));
    on(T.REMOTE_KEY_DOWN, (m, phone) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_DOWN, code: m.code }, phone));
    on(T.REMOTE_KEY_UP, (m, phone) => typeof m.code === 'string' && CODE.test(m.code) && this._ev({ t: T.K_KEY_UP, code: m.code }, phone));

    // Characters no key types here (Cyrillic, accents…): typed as they are. Control characters don't go.
    on(T.REMOTE_TEXT, (m, phone) => {
      if (!this.canType || typeof m.text !== 'string') return;
      const text = [...m.text.replace(/\p{Cc}/gu, '')].slice(0, 64).join('');
      if (text && this._take(phone)) this.helper.send('type', { text });
    });

    on(T.REMOTE_PAD, (m, phone) => {
      const ph = this._phoneState(phone);
      const proc = (ph && ph.padProc) || this.padProc;
      if (proc && this._take(phone)) proc.stdin.write(padBytes(m));
    });

    on(T.REMOTE_RELEASE, (m, phone) => {
      this.release(phone);
      const ph = this._phoneState(phone);
      if (ph) {
        ph.opened = false;
      }
      this.opened = this._phones.size > 0 ? [...this._phones.values()].some((p) => p.opened) : false;
      this.onChange();
    });

    // The phone went away holding a key (Wi-Fi dropped mid-press): let it go here.
    server.on('closed', (info) => {
      const phone = info ? this._phoneOf(null, info) : null;
      if (phone && this._phoneId(phone) !== 'single') {
        this.release(phone);
        this._padStop(phone);
        this._removePhone(phone);
      } else {
        this.release();
        this._padStop();
        this._phones.clear();
        this.padProc = null;
      }
      this.opened = this._phones.size > 0 ? [...this._phones.values()].some((p) => p.opened) : false;
      this.onChange();
    });
  }

  _phoneOf(m, ctx) {
    if (ctx && (ctx.os === P.OS.ANDROID || isPhone(ctx))) return ctx;
    if (m && m.phoneId) {
      const id = m.phoneId;
      const existing = this._phones.get(id);
      if (existing) return existing;
      return { id, deviceId: id, os: P.OS.ANDROID, name: 'Android' };
    }
    if (this.server && this.server.current && isPhone(this.server.current)) return this.server.current;
    if (this.server && typeof this.server.all === 'function') {
      const all = this.server.all();
      if (all.length === 1) return all[0];
    }
    return null;
  }

  _phoneId(phone) {
    if (!phone) return null;
    return typeof phone === 'object' ? (phone.deviceId || phone.id || 'single') : String(phone);
  }

  _ensurePhone(phone) {
    const id = this._phoneId(phone) || 'single';
    let ph = this._phones.get(id);
    if (!ph) {
      ph = {
        id,
        name: (phone && phone.name) || 'Android',
        opened: false,
        lastInput: 0,
        held: false,
        slot: null,
        padProc: null,
      };
      this._phones.set(id, ph);
    } else if (phone && phone.name && ph.name !== phone.name) {
      ph.name = phone.name;
    }
    return ph;
  }

  _phoneState(phone) {
    const id = this._phoneId(phone);
    if (!id) return null;
    return this._phones.get(id) || null;
  }

  _removePhone(phone) {
    const id = this._phoneId(phone);
    if (!id) return;
    const ph = this._phones.get(id);
    if (ph) {
      if (ph.slot) this._freeSlot(id);
      this._phones.delete(id);
    }
  }

  _allocSlot(phoneId) {
    for (let s = 1; s <= 4; s++) {
      if (!this._slots.has(s)) {
        this._slots.set(s, phoneId);
        return s;
      }
    }
    return null;
  }

  _freeSlot(phoneId) {
    for (const [slot, id] of this._slots.entries()) {
      if (id === phoneId) {
        this._slots.delete(slot);
        return slot;
      }
    }
    return null;
  }

  get allow() {
    const r = this.getSettings().remote;
    return !(r && r.allow === false);
  }

  // Why it isn't taken now, '' when it is.
  get why() {
    if (!this.allow) return 'Remote is off on this computer: turn it on in TwinDesk’s Remote page there';
    if (!this.atHome()) return 'This computer’s mouse is on another device now (Cursor): bring it back first';
    return '';
  }

  // The Remote tab's switch (and its answer to the phone).
  setAllow(on) {
    const s = this.getSettings();
    s.remote = { ...(s.remote || {}), allow: !!on };
    if (!on) this.release();
    this._state();
    this.onChange();
  }

  get padOn() {
    const r = this.getSettings().remote;
    return !!(r && r.pad === true);
  }

  // The Remote tab's Real gamepad switch: on installs the driver the first time.
  setPad(on) {
    const s = this.getSettings();
    s.remote = { ...(s.remote || {}), pad: !!on };
    this.save();
    this.padMessage = '';
    if (on) this._padStart();
    else this._padStop();
    this._state();
    this.onChange();
  }

  async _padStart(phone = null) {
    if (!this.loadPad) return;
    if (this._padPromise) {
      await this._padPromise;
      if (this.padOn) {
        this._startPadFor(phone);
        this.onChange();
      }
      return;
    }
    const say = (busy, message = this.padMessage) => {
      this.padBusy = busy;
      this.padMessage = message;
      this.onChange();
    };
    this._padPromise = (async () => {
      if (!this.pad) this.pad = this.loadPad();
      say('Checking…');
      const c = await this.pad.check();
      if (!c.supported) {
        this.padSupported = false;
        say('', c.message || 'Not on this computer');
        return false;
      }
      if (!c.installed) {
        say('Installing…');
        await this.pad.install();
      }
      say('');
      return true;
    })();

    let ok = false;
    try {
      ok = await this._padPromise;
    } catch (e) {
      // Not installed (the prompt declined, the download failed): off again, and why.
      const s = this.getSettings();
      s.remote = { ...(s.remote || {}), pad: false };
      this.save();
      say('', e.message || String(e));
      this._state();
      this._padPromise = null;
      return;
    }
    this._padPromise = null;
    if (!ok || !this.padOn) return;

    this._startPadFor(phone);
    this.onChange();
  }

  _startPadFor(phone = null) {
    const startFor = (ph) => {
      if (!ph || ph.padProc) return;
      let slot = ph.slot;
      if (!slot) {
        slot = this._allocSlot(ph.id);
        if (!slot) return;
        ph.slot = slot;
      }
      const p = this.pad.feed((code) => {
        if (ph.padProc !== p) return;
        ph.padProc = null;
        this._freeSlot(ph.id);
        ph.slot = null;
        if (this.padProc === p) {
          this.padProc = null;
          const next = [...this._phones.values()].find((x) => x.padProc);
          if (next) this.padProc = next.padProc;
        }
        if (this.padOn && code !== 0 && code !== null) {
          this.padMessage = 'The controller stopped: turn Real gamepad off and on again';
        }
        this._state(ph);
        this.onChange();
      }, slot);
      ph.padProc = p;
      if (!this.padProc) this.padProc = p;
      this._state(ph);
    };

    if (phone) {
      const ph = this._ensurePhone(phone);
      if (ph.opened || (this.server.current && isPhone(this.server.current))) startFor(ph);
    } else {
      if (this._phones.size > 0) {
        for (const ph of this._phones.values()) {
          if (ph.opened) startFor(ph);
        }
      } else if (isPhone(this.server.current)) {
        const ph = this._ensurePhone(this.server.current);
        startFor(ph);
      }
    }
  }

  _padStop(phone = null) {
    const stopProc = (p, ph = null) => {
      if (!p) return;
      if (ph) {
        ph.padProc = null;
        this._freeSlot(ph.id);
        ph.slot = null;
      }
      p.stdin.write(PAD_ZERO);
      p.stdin.end();
      setTimeout(() => { try { p.kill(); } catch {} }, 2000);
    };

    if (phone) {
      const ph = this._phoneState(phone);
      if (ph && ph.padProc) {
        const proc = ph.padProc;
        if (this.padProc === proc) this.padProc = null;
        stopProc(proc, ph);
        if (!this.padProc) {
          const next = [...this._phones.values()].find((x) => x.padProc);
          if (next) this.padProc = next.padProc;
        }
      }
    } else {
      const stopped = new Set();
      for (const ph of this._phones.values()) {
        if (ph.padProc && !stopped.has(ph.padProc)) {
          stopped.add(ph.padProc);
          stopProc(ph.padProc, ph);
        }
      }
      if (this.padProc && !stopped.has(this.padProc)) {
        stopProc(this.padProc);
      }
      this.padProc = null;
    }
  }

  // This computer's mouse went to another device or came back: the phone hears whether it's taken.
  refresh() {
    this._state();
    this.onChange();
  }

  _sendTo(phone, msg) {
    if (!phone) return;
    const phoneId = phone.deviceId || phone.id;
    if (typeof this.server.sendToClient === 'function') {
      try {
        this.server.sendToClient(msg, phoneId);
      } catch {}
    } else if (typeof this.server.send === 'function') {
      try {
        this.server.send(phone, msg);
      } catch {}
    }
  }

  _state(phone = null) {
    const why = this.why;
    if (phone) {
      const ph = this._phoneState(phone);
      const pad = !why && !!((ph && ph.padProc) || this.padProc);
      const msg = { t: T.REMOTE_STATE, allowed: !why, why, pad, text: this.canType };
      this._sendTo(phone, msg);
    } else {
      if (this._phones.size > 0) {
        for (const ph of this._phones.values()) {
          const pad = !why && !!ph.padProc;
          const msg = { t: T.REMOTE_STATE, allowed: !why, why, pad, text: this.canType };
          this._sendTo(ph, msg);
        }
      }
      if (isPhone(this.server && this.server.current)) {
        const msg = { t: T.REMOTE_STATE, allowed: !why, why, pad: !why && !!this.padProc, text: this.canType };
        this.server.sendToClient(msg);
      }
    }
  }

  // Whether the helper types text (an older one doesn't; nor does Linux on Wayland): the phone sends
  // remote.text only then.
  _askType() {
    Promise.resolve()
      .then(() => this.helper.request('keyLayout', {}))
      .then((r) => {
        const can = !!(r && r.type === true);
        if (can === this.canType) return;
        this.canType = can;
        this._state();
      })
      .catch(() => {});
  }

  // Input from the phone is taken now (or the phone hears why not); it's "in use".
  _take(phone = null) {
    if (this.why) {
      // Tell the phone (it says why on its Remote page), at most once a second.
      const now = Date.now();
      if (now - this.refusedAt > 1000) {
        this.refusedAt = now;
        this._state(phone);
        this.onChange();
      }
      return false;
    }
    const ph = phone ? this._ensurePhone(phone) : null;
    const was = ph ? ph.lastInput : this.lastInput;
    const now = Date.now();
    if (ph) ph.lastInput = now;
    this.lastInput = now;
    if (now - was > USING_MS) this.onChange(); // "in use now"
    clearTimeout(this.usingTimer);
    this.usingTimer = setTimeout(() => this.onChange(), USING_MS + 100);
    return true;
  }

  _ev(ev, phone = null) {
    if (!this._take(phone)) return;
    const ph = phone ? this._ensurePhone(phone) : null;
    if (ev.t === T.K_DOWN || ev.t === T.K_KEY_DOWN) {
      if (ph) ph.held = true;
      this.held = true;
    }
    this.helper.send('inject', { ev });
  }

  release(phone = null) {
    let padWritten = false;
    if (phone) {
      const ph = this._phoneState(phone);
      if (ph && ph.padProc) {
        ph.padProc.stdin.write(PAD_ZERO);
        padWritten = true;
      }
      if (ph && ph.held) {
        ph.held = false;
        if (this.atHome()) this.helper.send('releaseAll');
      }
    } else {
      for (const ph of this._phones.values()) {
        if (ph.padProc) {
          ph.padProc.stdin.write(PAD_ZERO);
          padWritten = true;
        }
        ph.held = false;
      }
    }
    if (!padWritten && this.padProc) {
      this.padProc.stdin.write(PAD_ZERO);
    }
    if (!phone && this.held) {
      this.held = false;
      if (this.atHome()) this.helper.send('releaseAll');
    }
    this.held = [...this._phones.values()].some((p) => p.held);
  }

  // For the Remote tab (state.remote).
  get view() {
    const phonesList = [];
    let idx = 0;
    const known = new Map(this._phones);
    if (this.server && typeof this.server.all === 'function') {
      for (const c of this.server.all()) {
        const id = c.id || c.deviceId;
        if (!known.has(id)) {
          known.set(id, { id, name: c.name || 'Android', opened: false, lastInput: 0, held: false, slot: null, padProc: null });
        }
      }
    } else if (this.server && this.server.current && isPhone(this.server.current)) {
      const c = this.server.current;
      const id = c.id || c.deviceId;
      if (!known.has(id)) {
        known.set(id, { id, name: c.name || 'Android', opened: this.opened, lastInput: this.lastInput, held: this.held, slot: null, padProc: this.padProc });
      }
    }

    for (const [id, ph] of known.entries()) {
      idx++;
      const isUsing = Date.now() - ph.lastInput < USING_MS;
      phonesList.push({
        id,
        name: ph.name || `Android ${idx}`,
        label: `Android ${idx}`,
        opened: !!ph.opened,
        using: isUsing,
        slot: ph.slot || null,
        pad: {
          live: !!ph.padProc,
          slot: ph.slot || null,
        },
      });
    }

    return {
      allow: this.allow,
      why: this.why,
      opened: (this.opened && isPhone(this.server && this.server.current)) || phonesList.some((p) => p.opened),
      using: Date.now() - this.lastInput < USING_MS || phonesList.some((p) => p.using),
      pad: {
        on: this.padOn,
        supported: this.padSupported,
        live: !!this.padProc || phonesList.some((p) => p.pad.live),
        busy: this.padBusy,
        message: this.padSupported ? this.padMessage : (this.padMessage || this.padNote),
        name: this.pad ? this.pad.name : '',
      },
      phones: phonesList,
    };
  }
}

module.exports = { PhoneRemote, padBytes };
