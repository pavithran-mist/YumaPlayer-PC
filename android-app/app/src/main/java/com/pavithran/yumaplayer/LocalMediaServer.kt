package com.pavithran.yumaplayer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.BufferedOutputStream
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

class LocalMediaServer(private val context: Context) {
    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    @Volatile
    var port: Int = 0
        private set

    fun start() {
        if (serverSocket != null) return
        val ss = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        serverSocket = ss
        port = ss.localPort
        pool.execute {
            while (!ss.isClosed) {
                try {
                    val client = ss.accept()
                    pool.execute { handleClient(client) }
                } catch (_: Exception) {
                    break
                }
            }
        }
    }

    fun stop() {
        try {
            serverSocket?.close()
        } catch (_: Exception) { }
        serverSocket = null
        pool.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream()))
            val requestLine = reader.readLine() ?: return
            var rangeHeader: String? = null
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                if (line.startsWith("Range:", ignoreCase = true)) {
                    rangeHeader = line.substringAfter(":").trim()
                }
            }

            val out = BufferedOutputStream(s.getOutputStream())
            val parts = requestLine.split(" ")
            val method = parts.getOrNull(0) ?: "GET"
            val target = parts.getOrNull(1) ?: "/"

            if (method == "OPTIONS") {
                out.write(
                    ("HTTP/1.1 204 No Content\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                        "Access-Control-Allow-Headers: Range\r\n\r\n").toByteArray()
                )
                out.flush()
                return
            }

            if (!target.startsWith("/local?uri=")) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
                out.flush()
                return
            }

            val encodedUri = target.substringAfter("/local?uri=")
            val uri = Uri.parse(URLDecoder.decode(encodedUri, "UTF-8"))
            val mime = context.contentResolver.getType(uri) ?: guessMime(uri)
            val totalSize = querySize(uri)

            if (rangeHeader != null && totalSize > 0) {
                val match = Regex("bytes=(\\d*)-(\\d*)").find(rangeHeader)
                val start = match?.groupValues?.getOrNull(1)?.toLongOrNull() ?: 0L
                val end = (match?.groupValues?.getOrNull(2)?.toLongOrNull() ?: (totalSize - 1)).coerceAtMost(totalSize - 1)
                val len = (end - start + 1).coerceAtLeast(0L)

                out.write(
                    ("HTTP/1.1 206 Partial Content\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Accept-Ranges: bytes\r\n" +
                        "Content-Type: $mime\r\n" +
                        "Content-Range: bytes $start-$end/$totalSize\r\n" +
                        "Content-Length: $len\r\n\r\n").toByteArray()
                )
                if (method != "HEAD") {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        skipFully(input, start)
                        copyRange(input, out, len)
                    }
                }
            } else {
                val hdr = StringBuilder("HTTP/1.1 200 OK\r\n")
                    .append("Access-Control-Allow-Origin: *\r\n")
                    .append("Accept-Ranges: bytes\r\n")
                    .append("Content-Type: $mime\r\n")
                if (totalSize > 0) hdr.append("Content-Length: $totalSize\r\n")
                hdr.append("\r\n")
                out.write(hdr.toString().toByteArray())
                if (method != "HEAD") {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        input.copyTo(out, 16384)
                    }
                }
            }
            out.flush()
        }
    }

    private fun skipFully(input: java.io.InputStream, bytesToSkip: Long) {
        var remaining = bytesToSkip
        val buf = ByteArray(8192)
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
            } else {
                val read = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (read <= 0) break
                remaining -= read
            }
        }
    }

    private fun copyRange(input: java.io.InputStream, out: BufferedOutputStream, length: Long) {
        var remaining = length
        val buf = ByteArray(16384)
        while (remaining > 0) {
            val toRead = minOf(buf.size.toLong(), remaining).toInt()
            val read = input.read(buf, 0, toRead)
            if (read <= 0) break
            out.write(buf, 0, read)
            remaining -= read
        }
    }

    private fun querySize(uri: Uri): Long {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.SIZE)
                if (idx >= 0) return c.getLong(idx)
            }
        }
        return -1L
    }

    private fun guessMime(uri: Uri): String {
        val s = uri.toString().lowercase()
        return when {
            s.endsWith(".flac") -> "audio/flac"
            s.endsWith(".wav") -> "audio/wav"
            s.endsWith(".mp3") -> "audio/mpeg"
            s.endsWith(".ogg") || s.endsWith(".opus") -> "audio/ogg"
            s.endsWith(".mp4") -> "video/mp4"
            s.endsWith(".webm") -> "video/webm"
            else -> "audio/mpeg"
        }
    }
}
