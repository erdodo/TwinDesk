// Tests for ClipSync.kt (mirrors shared/test/clipsync.js). Run with: ./gradlew testFullDebugUnitTest
package com.twindesk.android

import com.twindesk.android.ClipSync.Clock
import com.twindesk.android.ClipSync.Latest
import com.twindesk.android.ClipSync.Stamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ClipSyncTest {
    private class Dev(val id: String, t0: Long) {
        var t = t0
        val latest = Latest(id, Clock { t })
        var board = "" // the fake clipboard

        fun copy(text: String): Stamp { board = text; return latest.copied("text") }

        // The Clip.kt rule for an incoming text: applied only when Latest says so.
        fun receive(text: String, s: Stamp?): Boolean {
            val ok = latest.accept(s?.ts ?: 0, s?.o, null, "text")
            if (ok) board = text
            return ok
        }
    }

    private fun png(n: Int = 100) = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + ByteArray(n) { 1 }

    // The reported bug: Windows copies A, then the Mac copies B; A's late push must not replace B.
    @Test fun lateOlderPushDoesNotReplaceNewerCopy() {
        val w = Dev("W", 1000)
        val m = Dev("M", 1000)
        val a = w.copy("A")
        m.t = 1500
        val b = m.copy("B")
        m.t = 1600
        assertFalse(m.receive("A", a))
        assertEquals("B", m.board)
        w.t = 1700
        assertTrue(w.receive("B", b))
        assertEquals("B", w.board)
        assertFalse(w.receive("A", a))
        assertEquals("B", w.board)
    }

    @Test fun copyRightAfterReceivingIsNewerEvenWithClockBehind() {
        val w = Dev("W", 5000)
        val m = Dev("M", 1000)
        val a = w.copy("A")
        m.t = 1100
        assertTrue(m.receive("A", a))
        val b = m.copy("B")
        assertTrue(b.ts > a.ts)
        w.t = 5200
        assertTrue(w.receive("B", b))
    }

    @Test fun farFutureClockDoesNotWinForEver() {
        val m = Dev("M", 1000)
        assertTrue(m.latest.accept(1_000_000_000_000L, "X", null, "text"))
        m.t = 1500
        val mine = m.latest.copied("text")
        assertTrue(mine.ts <= 1500 + ClipSync.SKEW_MS + 10)
    }

    @Test fun tiesOwnEchoAndOldApps() {
        assertTrue(ClipSync.compare(Stamp(5, "a"), Stamp(5, "b")) < 0)
        assertTrue(ClipSync.compare(Stamp(5, "b"), Stamp(5, "a")) > 0)
        assertEquals(0, ClipSync.compare(Stamp(5, "a"), Stamp(5, "a")))
        val m = Dev("M", 1000)
        assertTrue(m.latest.accept(0, null, null, "text")) // no ts: copied on arrival
        assertFalse(m.latest.accept(900, "M", null, "text")) // our own copy coming back
        assertTrue(ClipSync.validStamp(1, "a"))
        assertFalse(ClipSync.validStamp(-1, "a"))
        assertFalse(ClipSync.validStamp(1, null))
        assertFalse(ClipSync.validStamp(1, ""))
        // an old app's later message still counts as newer than what we hold
        m.t = 1100
        assertTrue(m.latest.accept(0, null, "PC", "text"))
    }

    @Test fun clipLatestSaysWhoHoldsTheNewerCopy() {
        val w = Dev("W", 1000)
        val m = Dev("M", 1000)
        assertNull(w.latest.latest())
        w.copy("x")
        val lm = w.latest.latest()!!
        assertTrue(m.latest.isNewer(lm.ts, lm.o))
        m.t = 2000
        m.latest.copied("image")
        val ml = m.latest.latest()!!
        assertEquals("image", ml.kind)
        assertTrue(w.latest.isNewer(ml.ts, ml.o))
        assertFalse(m.latest.isNewer(lm.ts, lm.o))
        assertFalse(m.latest.isNewer(0, null))
    }

    @Test fun pendingCopyAndEagerItemsAreTracked() {
        val m = Dev("M", 1000)
        val s = m.latest.copied("text")
        assertTrue(m.latest.isCurrent(s))
        assertTrue(m.latest.accept(5000, "W", null, "files", "fid"))
        assertFalse(m.latest.isCurrent(s))
        assertTrue(m.latest.isCurrentId("fid"))
        m.t = 6000
        m.latest.copied("text")
        assertFalse(m.latest.isCurrentId("fid"))
    }

    @Test fun images() {
        val p = png()
        val b64 = Base64.getEncoder().encodeToString(p)
        val img = ClipSync.readImage("i1", 4, 3, b64)
        assertNotNull(img)
        assertTrue(img!!.png.contentEquals(p))
        assertEquals(4, img.w)
        assertEquals(3, img.h)
        assertNull(ClipSync.readImage("i1", 4, 3, Base64.getEncoder().encodeToString("not a png at all".toByteArray())))
        assertNull(ClipSync.readImage("", 4, 3, b64))
        assertNull(ClipSync.readImage("i1", 4, 3, "%%%"))
        assertNull(ClipSync.readImage("i1", 4, 3, "A".repeat(ClipSync.IMAGE_MAX_BYTES * 2)))
        assertNull(ClipSync.readImage("i1", 4, 3, Base64.getEncoder().encodeToString(png(ClipSync.IMAGE_MAX_BYTES))))
    }
}
