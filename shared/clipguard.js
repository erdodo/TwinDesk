// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two guards against a clipboard loop (a copy that bounces between devices for ever):
//  - EchoGuard: what we just wrote to the clipboard (an item from another device, or the one we
//    just sent) is remembered by its CONTENT for a few seconds. A clipboard change whose content is
//    in that list is the echo of our own write (the system touching the formats, converting the
//    image, normalising line breaks), never a new copy.
//  - Breaker: when copies are detected faster than a person can make them, stamping and sending
//    pause for a while (and the page can say so) instead of feeding a loop.
// Pure: no clipboard, no sockets. Used by Windows, Mac, Linux and ported to Kotlin (Android).
'use strict';

const crypto = require('crypto');

// Line breaks differ between systems (\r\n, \r, \n); trailing spaces are not content either.
function normText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t ]+$/g, '').replace(/\n+$/g, '');
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// The content keys: the same content gives the same key on every system.
const textKey = (text) => 't' + sha(normText(text));
// An image by its size and a sample of its pixels (never its PNG bytes: encoders differ).
const imageKey = (w, h, sampleHash) => `i${w | 0}x${h | 0}:${sampleHash}`;
// Files by their names and sizes (paths differ between devices).
const filesKey = (files) => 'f' + sha((files || []).map((f) => `${f.name}:${f.size | 0}`).sort().join('|'));

class EchoGuard {
  constructor({ ttlMs = 8000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.keys = new Map(); // key -> until
  }

  // Remember content we just wrote or sent.
  note(key) {
    if (!key) return;
    const t = this.now();
    this.keys.set(key, t + this.ttlMs);
    for (const [k, until] of this.keys) if (until < t) this.keys.delete(k);
  }

  // Is this clipboard content something we wrote or sent a moment ago?
  isEcho(key) {
    const until = this.keys.get(key);
    return until !== undefined && until >= this.now();
  }
}

class Breaker {
  // More than `max` stamped copies within `windowMs` trips it for `pauseMs`.
  constructor({ max = 8, windowMs = 10000, pauseMs = 30000, now = Date.now } = {}) {
    Object.assign(this, { max, windowMs, pauseMs, now });
    this.hits = [];
    this.until = 0;
    this.trips = 0;
  }

  get paused() {
    return this.now() < this.until;
  }

  // A copy was detected: false = too many, do not stamp or send it.
  hit() {
    const t = this.now();
    if (t < this.until) return false;
    this.hits = this.hits.filter((x) => t - x < this.windowMs);
    this.hits.push(t);
    if (this.hits.length > this.max) {
      this.until = t + this.pauseMs;
      this.hits = [];
      this.trips++;
      return false;
    }
    return true;
  }
}

module.exports = { normText, textKey, imageKey, filesKey, EchoGuard, Breaker };
