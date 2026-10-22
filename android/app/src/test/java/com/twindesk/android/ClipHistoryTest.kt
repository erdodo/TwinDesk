// Tests for ClipHistory.kt (mirrors shared/test/clip-history.js). Run with: ./gradlew testFullDebugUnitTest
package com.twindesk.android

import com.twindesk.android.ClipHistory.Content
import com.twindesk.android.ClipHistory.Src
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ClipHistoryTest {
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + ByteArray(1000) { 7 }
    private fun tmp() = Files.createTempDirectory("cliphist-").toFile()
    private var t = 1000L
    private fun hist(dir: File, max: Int = 5, maxBytes: Long = 1024 * 1024) = ClipHistory(dir, max, maxBytes) { t++ }

    @Test fun textNewestFirstAndSameMovesUp() {
        val h = hist(File(tmp(), "kept"))
        h.addText("out", "one")
        h.addText("in", "two\nlines")
        h.addText("out", "one")
        val l = h.list()
        assertEquals(listOf("one", "two lines"), l.map { it.title })
        assertEquals("two\nlines", h.preview(l[1].id)!!.text)
        assertEquals("one", (h.content(l[0].id) as Content.Text).text)
    }

    @Test fun imageKeptCopiedAgainAndPreviewed() {
        val h = hist(File(tmp(), "kept"))
        val id = h.addImage("in", png, 640, 480)!!
        assertEquals("Image 640×480", h.list()[0].title)
        assertTrue(png.contentEquals((h.content(id) as Content.Image).file.readBytes()))
        assertNotNull(h.preview(id)!!.image)
    }

    @Test fun filesKeptWholeAfterTheOriginalsAreGone() {
        val root = tmp()
        val h = hist(File(root, "kept"))
        val src = File(root, "src")
        File(src, "sub").mkdirs()
        File(src, "report.pdf").writeText("pdfdata")
        File(src, "sub/a.txt").writeText("aaa")
        val id = h.addFiles("out", listOf(Src(null, file = File(src, "report.pdf")), Src(null, file = File(src, "sub"))))!!
        assertEquals("report.pdf +1 more", h.list()[0].title)
        assertEquals("2 files", h.list()[0].sub)
        src.deleteRecursively()
        val c = h.content(id) as Content.Files
        assertEquals(2, c.paths.size)
        assertTrue(c.paths.all { it.exists() })
        assertEquals("aaa", File(c.paths[1], "a.txt").readText())
        val pv = h.preview(id)!!
        assertEquals(listOf("report.pdf", "sub"), pv.files.map { it.name })
        assertTrue(pv.files[1].isDir)
    }

    @Test fun filesFromAStreamAndDuplicateNames() {
        val h = hist(File(tmp(), "kept"))
        val id = h.addFiles("in", listOf(Src("a.txt", 3) { "abc".byteInputStream() }, Src("a.txt", 3) { "xyz".byteInputStream() }))!!
        val c = h.content(id) as Content.Files
        assertEquals(listOf("a.txt", "a (2).txt"), c.paths.map { it.name })
        assertEquals("xyz", c.paths[1].readText())
        val gone = h.addFiles("in", listOf(Src("b.txt", 1) { null }))!!
        assertNull("a file that cannot be read is listed, not kept", h.content(gone))
        assertEquals("1 file · names only", h.list()[0].sub)
    }

    @Test fun limitsByCountAndBytes() {
        val root = tmp()
        val dir = File(root, "kept")
        val h = hist(dir)
        val iid = h.addImage("in", png, 1, 1)!!
        for (i in 0 until 6) h.addText("in", "x$i")
        assertEquals(5, h.list().size)
        assertFalse("an evicted image is deleted from disk", File(dir, iid).exists())
        val big = hist(File(root, "big"), 10, 4100)
        val a = big.addImage("in", png, 1, 1)!!
        for (i in 0 until 4) big.addImage("in", png + "b$i".toByteArray(), 1, 1)
        assertNull("over the byte budget the oldest kept image goes", big.get(a))
        assertTrue(big.list().size >= 3)
        val huge = big.addImage("in", ByteArray(2000) { 9 }, 9, 9)!!
        assertFalse(big.list()[0].kept)
        assertNull(big.content(huge))
        assertNull(big.preview(huge)!!.image)
    }

    @Test fun offRemoveClearWipe() {
        val root = tmp()
        val dir = File(root, "kept")
        assertNull(ClipHistory(dir, 0).addText("in", "x"))
        assertNull(ClipHistory(dir, 0).addImage("in", png, 1, 1))
        assertFalse("off keeps nothing on disk", dir.exists())
        val h = hist(dir)
        h.addText("in", "a")
        assertTrue(h.remove(h.list()[0].id))
        h.addText("in", "b")
        h.clear()
        assertEquals(0, h.list().size)
        h.addImage("in", png, 1, 1)
        h.wipe()
        assertTrue(!dir.exists() && h.list().isEmpty())
        h.setMax(0)
        assertNull(h.addText("in", "z"))
    }
}
