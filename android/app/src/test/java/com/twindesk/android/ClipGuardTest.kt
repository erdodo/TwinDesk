// Tests for ClipGuard.kt (mirrors shared/test/clipguard.js, and the loop tests of the desktop clipboards).
// Run with: ./gradlew testFullDebugUnitTest
package com.twindesk.android

import com.twindesk.android.ClipGuard.textKey
import com.twindesk.android.ClipSync.Clock
import com.twindesk.android.ClipSync.Latest
import com.twindesk.android.ClipWatch.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipGuardTest {
    private var t = 1000L

    @Test fun keysIgnoreLineBreaksAndFormats() {
        assertEquals(textKey("a\r\nb\r\n"), textKey("a\nb"))
        assertEquals(textKey("a\rb  "), textKey("a\nb"))
        assertNotEquals(textKey("a\nb"), textKey("a\nc"))
        val f1 = ClipGuard.filesKey(listOf("a.pdf" to 10L, "b.txt" to 3L))
        assertEquals(f1, ClipGuard.filesKey(listOf("b.txt" to 3L, "a.pdf" to 10L)))
        assertNotEquals(f1, ClipGuard.filesKey(listOf("a.pdf" to 11L, "b.txt" to 3L)))
        // a shade that changes below the upper 4 bits (a re-encode) is the same picture
        assertEquals(
            ClipGuard.sampleHash(64, 64) { x, y -> (x * 4 shl 16) or (y * 4 shl 8) },
            ClipGuard.sampleHash(64, 64) { x, y -> ((x * 4 shl 16) or (y * 4 shl 8)) + 1 },
        )
    }

    @Test fun echoGuardRemembersForAFewSeconds() {
        val e = EchoGuard(8000) { t }
        e.note("k")
        assertTrue(e.isEcho("k"))
        assertFalse(e.isEcho("other"))
        t += 9000
        assertFalse(e.isEcho("k"))
    }

    @Test fun breakerPausesARunawayDetectorNotAPerson() {
        val b = Breaker(8, 10_000, 30_000) { t }
        // a person copying every 3 s is never blocked
        repeat(40) { assertTrue(b.hit()); t += 3000 }
        assertFalse(b.paused)
        // a runaway: 20 copies a second
        var blocked = 0
        repeat(40) { if (!b.hit()) blocked++; t += 50 }
        assertTrue(blocked > 25)
        assertTrue(b.paused)
        t += 31_000
        assertFalse(b.paused)
        assertTrue(b.hit())
    }

    // ---- two devices that write to each other, with a system that rewrites the clipboard after a write ----

    // A fake phone/computer. `rewrite` is what the system does to the content after we wrote it.
    private class Dev(val id: String, val t: () -> Long, val guarded: Boolean, val rewrite: (String) -> String) {
        val latest = Latest(id, Clock { t() })
        val watch = ClipWatch(EchoGuard(8000, t), Breaker(8, 10_000, 30_000, t))
        var board = ""
        var peer: Dev? = null
        var sent = 0
        var applied = 0
        var oldSig: String? = null // the old rule: raw text of the last read
        var known = false

        // The key the device decides by: content (new) or the raw text (old code).
        private fun key(text: String) = if (guarded) textKey(text) else "t:$text"

        // The clipboard changed (listener): a copy made here, or an echo.
        fun changed() {
            if (sent > 50) return // (the old rule would go on for ever)
            val text = board
            if (guarded) {
                val v = watch.detect(key(text), known)
                if (v != Verdict.COPY) return
            } else {
                if (key(text) == oldSig && known) return
                oldSig = key(text)
            }
            known = true
            val st = latest.copied("text")
            sent++
            peer!!.receive(text, st)
        }

        fun receive(text: String, st: ClipSync.Stamp) {
            if (!latest.accept(st.ts, st.o, null, "text")) return
            applied++
            known = false
            if (guarded) {
                if (textKey(board) == textKey(text)) return // already there: not written again
                watch.wrote(textKey(text))
            } else oldSig = null // (the old code forgot the signature after its own write)
            board = text
            board = rewrite(board) // the system touches it
            changed()
        }
    }

    private fun run(guarded: Boolean, rewrite: (String) -> String): Int {
        var clock = 5000L
        val tick = { clock++ ; clock }
        val a = Dev("a", tick, guarded, rewrite)
        val b = Dev("b", tick, guarded, rewrite)
        a.peer = b; b.peer = a
        a.board = "hello\nworld"
        a.changed() // the person copies on A
        return a.sent + b.sent
    }

    @Test fun windowsLineBreakRewriteSettles() {
        val crlf = { s: String -> s.replace("\n", "\r\n") }
        // the old rule loops (until the stack or the depth guard gives up); the new one settles
        assertTrue("the old rule loops", run(false, crlf) > 20)
        assertTrue(run(true, crlf) <= 4)
    }

    @Test fun trailingSpaceAndLoneCarriageReturnSettle() {
        assertTrue(run(true) { it.replace("\n", "\r") + "  " } <= 4)
    }

    @Test fun watchVerdicts() {
        val w = ClipWatch(EchoGuard(8000) { t }, Breaker(2, 10_000, 30_000) { t })
        assertEquals(Verdict.COPY, w.detect("a", false))
        assertEquals(Verdict.SAME, w.detect("a", true))
        w.wrote("b") // our write: the system touching it afterwards is an echo
        assertEquals(Verdict.ECHO, w.detect("b", false))
        assertEquals(Verdict.COPY, w.detect("c", true))
        assertEquals(Verdict.PAUSED, w.detect("d", true)) // third in the window with max 2
        assertEquals(Verdict.COPY, w.detect("e", true, force = true)) // a person pressing Send
    }
}
