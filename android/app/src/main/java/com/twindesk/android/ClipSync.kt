// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// "The latest copy wins" (shared/clipsync.js, ported; keep the two in step): what was copied last,
// on any device, is what every device pastes.
//
// Every copy gets a time (ts, o): ts from a hybrid logical clock (milliseconds that never go
// backwards and always move past any time seen from another device), o = the device that copied.
// A device applies an incoming item only when it is newer than the newest copy it knows of (its own
// last copy counts), so a late or repeated push of an older copy can no longer replace a newer one.
// Items from a device that sends no time (older apps) count as copied on arrival, as before.
// Pure: no Android, no sockets, no clipboard (ClipSyncTest.kt runs it on the JVM).
package com.twindesk.android

import java.util.Base64

object ClipSync {
    const val IMAGE_MAX_BYTES = 8 * 1024 * 1024 // shared/protocol.js CLIP_IMAGE_MAX_BYTES
    const val SKEW_MS = 10 * 60 * 1000L // shared/protocol.js CLIP_SKEW_MS
    const val MAX_ID = 128

    // The time of a copy.
    data class Stamp(val ts: Long, val o: String)

    // The newest copy a device knows of; kind: "text" | "image" | "files".
    data class Cur(val ts: Long, val o: String, val kind: String, val id: String?) {
        val stamp get() = Stamp(ts, o)
    }

    // An incoming clip.image checked.
    class Image(val id: String, val w: Int, val h: Int, val png: ByteArray)

    // Newer first by time, then by device id so two devices always agree on a tie.
    fun compare(a: Stamp, b: Stamp): Int {
        if (a.ts != b.ts) return if (a.ts < b.ts) -1 else 1
        if (a.o == b.o) return 0
        return if (a.o < b.o) -1 else 1
    }

    // ts 0 / o null: the message had none (an older app).
    fun validStamp(ts: Long, o: String?): Boolean =
        ts > 0 && ts < (1L shl 53) && o != null && o.isNotEmpty() && o.length <= MAX_ID

    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

    // The receiver only ever writes a PNG to its clipboard.
    fun isPng(b: ByteArray): Boolean = b.size >= 8 && (0 until 8).all { b[it] == PNG_SIGNATURE[it] }

    // An incoming clip.image checked (base64 length, PNG signature, size), or null.
    fun readImage(id: String?, w: Int, h: Int, b64: String?): Image? {
        if (b64.isNullOrEmpty() || b64.length > (IMAGE_MAX_BYTES * 4L + 2) / 3 + 8) return null
        if (id.isNullOrEmpty() || id.length > MAX_ID) return null
        val png = try { Base64.getDecoder().decode(b64) } catch (e: IllegalArgumentException) { return null }
        if (png.isEmpty() || png.size > IMAGE_MAX_BYTES || !isPng(png)) return null
        return Image(id, maxOf(0, w), maxOf(0, h), png)
    }

    // Hybrid logical clock.
    class Clock(private val now: () -> Long = System::currentTimeMillis) {
        private var last = 0L

        fun now(): Long = now.invoke()

        // The time of a copy made here: wall clock, but always past every time given or seen before.
        @Synchronized fun tick(): Long {
            last = maxOf(now(), last + 1)
            return last
        }

        // A time seen on another device: later ticks move past it (clamped, so a clock far in the
        // future cannot push ours there).
        @Synchronized fun observe(ts: Long) {
            if (ts <= 0) return
            last = maxOf(last, minOf(ts, now() + SKEW_MS))
        }
    }

    // The newest copy a device knows of.
    class Latest(val selfId: String, val clock: Clock = Clock()) {
        @Volatile var cur: Cur? = null; private set

        // A copy happened here: its time, which becomes the newest.
        @Synchronized fun copied(kind: String, id: String? = null): Stamp {
            val s = Stamp(clock.tick(), selfId)
            cur = Cur(s.ts, s.o, kind, id)
            return s
        }

        // An item from another device (ts/o, or neither: an older app; from: its device id if the
        // message names it). True = apply it. The item becomes the newest copy when it is applied.
        @Synchronized fun accept(ts: Long, o: String?, from: String?, kind: String, id: String? = null): Boolean {
            val s: Stamp
            if (validStamp(ts, o)) {
                s = Stamp(minOf(ts, clock.now() + SKEW_MS), o!!)
                clock.observe(ts)
            } else {
                s = Stamp(clock.tick(), if (!from.isNullOrEmpty()) from else "~peer")
            }
            if (s.o == selfId) return false // our own copy coming back
            val c = cur
            if (c != null && compare(s, c.stamp) <= 0) return false
            cur = Cur(s.ts, s.o, kind, id)
            return true
        }

        // The newest copy is this one (a copy that was noticed but is not read yet).
        fun isCurrent(s: Stamp): Boolean = cur?.stamp == s

        // The newest copy is this item (an eager transfer still wanted when it arrives).
        fun isCurrentId(id: String): Boolean = cur?.id == id

        // What to say after welcome (`clip.latest`): null when nothing was copied yet.
        fun latest(): Cur? = cur

        // The other side's `clip.latest`: true when it holds a newer copy than we know of (ask it for it).
        @Synchronized fun isNewer(ts: Long, o: String?): Boolean {
            if (!validStamp(ts, o)) return false
            clock.observe(ts)
            val c = cur ?: return true
            return compare(Stamp(ts, o!!), c.stamp) > 0
        }
    }
}
