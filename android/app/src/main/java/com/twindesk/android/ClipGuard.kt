// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two guards against a clipboard loop (a copy that bounces between devices for ever), shared/clipguard.js
// ported (keep the two in step):
//  - EchoGuard: what we just wrote to the clipboard (an item from the computer, or the one we
//    just sent) is remembered by its CONTENT for a few seconds. A clipboard change whose content is
//    in that list is the echo of our own write (a keyboard or the system re-setting the clip,
//    converting the image, normalising line breaks), never a new copy.
//  - Breaker: when copies are detected faster than a person can make them, stamping and sending
//    pause for a while (and the page says so) instead of feeding a loop.
// ClipWatch puts them together with "the content as last seen": the one decision Clip.kt takes
// for every clipboard change. Pure: no Android, no sockets (ClipGuardTest.kt runs it on the JVM).
package com.twindesk.android

import java.security.MessageDigest

object ClipGuard {
    private val TRAIL = Regex("[ \\t\\u00a0]+$")

    // Line breaks differ between systems (\r\n, \r, \n); trailing spaces are not content either.
    fun normText(text: String?): String =
        (text ?: "").replace(Regex("\r\n?"), "\n").replace(TRAIL, "").trimEnd('\n')

    private fun sha(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    // The content keys: the same content gives the same key whatever the formats around it.
    fun textKey(text: String?) = "t" + sha(normText(text))

    // An image by its size and a sample of its pixels (never its PNG bytes: encoders differ).
    fun imageKey(w: Int, h: Int, sampleHash: String) = "i${w}x$h:$sampleHash"

    // Files by their names and sizes (the uris differ every time).
    fun filesKey(files: List<Pair<String, Long>>) = "f" + sha(files.map { "${it.first}:${it.second.toInt()}" }.sorted().joinToString("|"))

    // A 16×16 grid of pixels (only the upper 4 bits of each colour, so a re-encode that changes
    // a shade does not change the key); pixel(x, y) is 0xAARRGGBB.
    fun sampleHash(w: Int, h: Int, pixel: (Int, Int) -> Int): String {
        val md = MessageDigest.getInstance("SHA-1")
        if (w <= 0 || h <= 0) return ""
        for (j in 0 until 16) for (i in 0 until 16) {
            val p = pixel(i * (w - 1) / 15, j * (h - 1) / 15) and 0x00F0F0F0
            md.update(byteArrayOf((p shr 16).toByte(), (p shr 8).toByte(), p.toByte()))
        }
        return md.digest().joinToString("") { "%02x".format(it) }.take(16)
    }
}

class EchoGuard(private val ttlMs: Long = 8000, private val now: () -> Long = System::currentTimeMillis) {
    private val keys = HashMap<String, Long>() // key -> until

    // Remember content we just wrote or sent.
    @Synchronized fun note(key: String?) {
        if (key.isNullOrEmpty()) return
        val t = now()
        keys[key] = t + ttlMs
        keys.entries.removeAll { it.value < t }
    }

    // Is this clipboard content something we wrote or sent a moment ago?
    @Synchronized fun isEcho(key: String): Boolean = (keys[key] ?: 0L) >= now() && keys.containsKey(key)
}

class Breaker(
    private val max: Int = 8,
    private val windowMs: Long = 10_000,
    private val pauseMs: Long = 30_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val hits = ArrayList<Long>()
    @Volatile var until = 0L; private set
    @Volatile var trips = 0; private set

    val paused get() = now() < until

    // A copy was detected: false = too many, do not stamp or send it.
    @Synchronized fun hit(): Boolean {
        val t = now()
        if (t < until) return false
        hits.removeAll { t - it >= windowMs }
        hits.add(t)
        if (hits.size > max) {
            until = t + pauseMs
            hits.clear()
            trips++
            return false
        }
        return true
    }
}

class ClipWatch(val echo: EchoGuard = EchoGuard(), val breaker: Breaker = Breaker()) {
    enum class Verdict { SAME, ECHO, PAUSED, COPY }

    private var last: String? = null // the content as last seen

    // Our own write (an item from the computer, Copy again): remembered, and the content is "seen".
    @Synchronized fun wrote(key: String?) {
        echo.note(key)
        last = key
    }

    // The content key could not be told (not readable): the next one is looked at fresh.
    @Synchronized fun forget() { last = null }

    @Synchronized fun adopt(key: String) { last = key }

    // The clipboard shows `key`. known: we hold a copy of it already (stamp and all).
    // force (a person pressed Send): guards are skipped, but a copy that is known goes with its stamp.
    @Synchronized fun detect(key: String, known: Boolean, force: Boolean = false): Verdict {
        if (key == last && known) return Verdict.SAME
        last = key
        if (force) return Verdict.COPY
        if (echo.isEcho(key)) return Verdict.ECHO
        if (!breaker.hit()) return Verdict.PAUSED
        echo.note(key) // it is going out: its echo is not another copy
        return Verdict.COPY
    }
}
