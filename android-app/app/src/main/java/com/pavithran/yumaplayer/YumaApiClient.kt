package com.pavithran.yumaplayer

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object YumaApiClient {

    private const val YTM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    fun upgradeArtworkUrl(url: String?): String {
        if (url.isNullOrBlank()) return ""
        if (url.contains("googleusercontent.com") || url.contains("ggpht.com")) {
            val wRe = Regex("=w\\d+-h\\d+[^?#]*")
            if (wRe.containsMatchIn(url)) return url.replace(wRe, "=w1200-h1200-l95-rj")
            val sRe = Regex("=s\\d+[^?#]*")
            if (sRe.containsMatchIn(url)) return url.replace(sRe, "=s1200")
        }
        if (url.contains("ytimg.com/vi/")) {
            return url.replace(Regex("/(default|mqdefault|hqdefault|sddefault)\\.jpg"), "/maxresdefault.jpg")
        }
        return url
    }

    private fun httpRequest(
        urlStr: String,
        method: String = "GET",
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
        timeoutMs: Int = 8000
    ): Pair<Int, String> {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("User-Agent", YTM_UA)
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        if (body != null) {
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
        val text = BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
        conn.disconnect()
        return code to text
    }

    private fun parseDurationText(text: String?): Int {
        if (text.isNullOrBlank()) return 0
        val parts = text.trim().split(":").mapNotNull { it.toIntOrNull() }
        return when (parts.size) {
            2 -> parts[0] * 60 + parts[1]
            3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
            else -> 0
        }
    }

    private fun extractText(obj: Any?): String {
        if (obj !is JSONObject) return ""
        if (obj.has("simpleText")) return obj.optString("simpleText", "")
        val runs = obj.optJSONArray("runs") ?: return ""
        val sb = StringBuilder()
        for (i in 0 until runs.length()) {
            sb.append(runs.optJSONObject(i)?.optString("text", "") ?: "")
        }
        return sb.toString()
    }

    private fun pickThumb(thumbObj: JSONObject?, videoId: String): String {
        val arr = thumbObj?.optJSONArray("thumbnails")
        if (arr != null && arr.length() > 0) {
            var bestUrl = ""
            var bestW = -1
            for (i in 0 until arr.length()) {
                val t = arr.optJSONObject(i) ?: continue
                val w = t.optInt("width", 0)
                val u = t.optString("url", "")
                if (w >= bestW && u.isNotBlank()) {
                    bestW = w
                    bestUrl = u
                }
            }
            if (bestUrl.isNotBlank()) return upgradeArtworkUrl(bestUrl)
        }
        return "https://i.ytimg.com/vi/$videoId/maxresdefault.jpg"
    }

    private fun collectYtmItems(node: Any?, mediaType: String, out: MutableList<JSONObject>, seen: MutableSet<String>) {
        when (node) {
            is JSONObject -> {
                // MusicResponsiveListItemRenderer (YTM Search & Shelves)
                if (node.has("flexColumns")) {
                    val videoId = node.optJSONObject("overlay")
                        ?.optJSONObject("musicItemThumbnailOverlayRenderer")
                        ?.optJSONObject("content")
                        ?.optJSONObject("musicPlayButtonRenderer")
                        ?.optJSONObject("playNavigationEndpoint")
                        ?.optJSONObject("watchEndpoint")
                        ?.optString("videoId", "")
                        ?.takeIf { it.isNotBlank() }
                        ?: node.optJSONObject("playlistItemData")?.optString("videoId", "") ?: ""

                    if (videoId.isNotBlank() && !seen.contains(videoId)) {
                        val cols = node.optJSONArray("flexColumns")
                        val title = extractText(cols?.optJSONObject(0)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text"))
                        val sub = extractText(cols?.optJSONObject(1)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text"))
                        val subParts = sub.split(" • ")
                        val artist = subParts.firstOrNull()?.takeIf { it.isNotBlank() } ?: "YouTube Music"
                        val durStr = subParts.lastOrNull { it.contains(":") }
                        val dur = parseDurationText(durStr)
                        val art = pickThumb(node.optJSONObject("thumbnail")?.optJSONObject("musicThumbnailRenderer")?.optJSONObject("thumbnail"), videoId)
                        if (title.isNotBlank()) {
                            seen.add(videoId)
                            out.add(JSONObject().apply {
                                put("id", "yt_$videoId")
                                put("videoId", videoId)
                                put("source", "youtube")
                                put("mediaType", mediaType)
                                put("title", title)
                                put("artist", artist)
                                put("album", if (mediaType == "video") "Music Video" else "YouTube Music")
                                put("duration", dur)
                                put("artwork", art)
                                put("codec", if (mediaType == "video") "VIDEO" else "OPUS")
                                put("lossless", false)
                            })
                        }
                    }
                }
                // MusicTwoRowItemRenderer (YTM Home Feed Cards)
                if (node.has("navigationEndpoint") && node.has("thumbnailRenderer") && node.has("title")) {
                    val vid = node.optJSONObject("navigationEndpoint")?.optJSONObject("watchEndpoint")?.optString("videoId", "") ?: ""
                    if (vid.isNotBlank() && !seen.contains(vid)) {
                        val title = extractText(node.optJSONObject("title"))
                        val artist = extractText(node.optJSONObject("subtitle")).ifBlank { "YouTube Music" }
                        val art = pickThumb(node.optJSONObject("thumbnailRenderer")?.optJSONObject("musicThumbnailRenderer")?.optJSONObject("thumbnail"), vid)
                        if (title.isNotBlank()) {
                            seen.add(vid)
                            out.add(JSONObject().apply {
                                put("id", "yt_$vid")
                                put("videoId", vid)
                                put("source", "youtube")
                                put("mediaType", mediaType)
                                put("title", title)
                                put("artist", artist)
                                put("album", "YouTube Music")
                                put("duration", 0)
                                put("artwork", art)
                                put("codec", "OPUS")
                                put("lossless", false)
                            })
                        }
                    }
                }
                // PlaylistPanelVideoRenderer (YTM Up Next)
                if (node.has("videoId") && node.has("shortBylineText")) {
                    val vid = node.optString("videoId", "")
                    if (vid.isNotBlank() && !seen.contains(vid)) {
                        val title = extractText(node.optJSONObject("title"))
                        val artist = extractText(node.optJSONObject("shortBylineText")).ifBlank { "YouTube Music" }
                        val dur = parseDurationText(extractText(node.optJSONObject("lengthText")))
                        val art = pickThumb(node.optJSONObject("thumbnail"), vid)
                        if (title.isNotBlank()) {
                            seen.add(vid)
                            out.add(JSONObject().apply {
                                put("id", "yt_$vid")
                                put("videoId", vid)
                                put("source", "youtube")
                                put("mediaType", mediaType)
                                put("title", title)
                                put("artist", artist)
                                put("album", "YouTube Music")
                                put("duration", dur)
                                put("artwork", art)
                                put("codec", "OPUS")
                                put("lossless", false)
                            })
                        }
                    }
                }
                // Standard YouTube VideoRenderer (Music Videos)
                if (node.has("videoId") && node.has("ownerText")) {
                    val vid = node.optString("videoId", "")
                    if (vid.isNotBlank() && !seen.contains(vid)) {
                        val title = extractText(node.optJSONObject("title"))
                        val artist = extractText(node.optJSONObject("ownerText")).ifBlank { "YouTube" }
                        val dur = parseDurationText(extractText(node.optJSONObject("lengthText")))
                        val art = pickThumb(node.optJSONObject("thumbnail"), vid)
                        if (title.isNotBlank()) {
                            seen.add(vid)
                            out.add(JSONObject().apply {
                                put("id", "yt_$vid")
                                put("videoId", vid)
                                put("source", "youtube")
                                put("mediaType", "video")
                                put("title", title)
                                put("artist", artist)
                                put("album", "Music Video")
                                put("duration", dur)
                                put("artwork", art)
                                put("codec", "VIDEO")
                                put("lossless", false)
                            })
                        }
                    }
                }
                val keys = node.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    collectYtmItems(node.opt(k), mediaType, out, seen)
                    if (out.size >= 30) return
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    collectYtmItems(node.opt(i), mediaType, out, seen)
                    if (out.size >= 30) return
                }
            }
        }
    }

    private fun ytmContext(): JSONObject = JSONObject().apply {
        put("client", JSONObject().apply {
            put("clientName", "WEB_REMIX")
            put("clientVersion", "1.20241120.01.00")
            put("hl", "en")
        })
    }

    private fun webContext(): JSONObject = JSONObject().apply {
        put("client", JSONObject().apply {
            put("clientName", "WEB")
            put("clientVersion", "2.20241120.01.00")
            put("hl", "en")
        })
    }

    fun searchMusic(query: String, mode: String = "all"): JSONArray {
        val clean = query.trim()
        if (clean.isEmpty()) return JSONArray()
        val results = mutableListOf<JSONObject>()
        val seen = mutableSetOf<String>()

        if (mode == "all" || mode == "songs") {
            try {
                val payload = JSONObject().apply {
                    put("context", ytmContext())
                    put("query", clean)
                    put("params", "EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D")
                }.toString()
                val (code, text) = httpRequest(
                    "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
                    "POST",
                    payload,
                    mapOf("Origin" to "https://music.youtube.com", "Referer" to "https://music.youtube.com/")
                )
                if (code in 200..299) {
                    collectYtmItems(JSONObject(text), "audio", results, seen)
                }
            } catch (_: Exception) { }
        }

        if (mode == "videos" || (mode == "all" && results.size < 16)) {
            try {
                val q = if (mode == "videos") "$clean official music video" else clean
                val payload = JSONObject().apply {
                    put("context", webContext())
                    put("query", q)
                }.toString()
                val (code, text) = httpRequest(
                    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
                    "POST",
                    payload,
                    mapOf("Origin" to "https://www.youtube.com", "Referer" to "https://www.youtube.com/")
                )
                if (code in 200..299) {
                    collectYtmItems(JSONObject(text), "video", results, seen)
                }
            } catch (_: Exception) { }
        }

        return JSONArray().apply { results.take(26).forEach { put(it) } }
    }

    fun getHomeDiscovery(): JSONArray {
        val sections = JSONArray()
        val queries = listOf(
            "Trending Hit Songs" to "top trending songs 2026 official",
            "Late Night Vibes" to "chill lo-fi night drive music",
            "Popular Music Videos" to "official music video hits"
        )
        for ((title, q) in queries) {
            val mode = if (title.contains("Video")) "videos" else "songs"
            val tracks = searchMusic(q, mode)
            if (tracks.length() > 0) {
                sections.put(JSONObject().apply {
                    put("title", title)
                    put("tracks", JSONArray().apply {
                        for (i in 0 until minOf(10, tracks.length())) put(tracks.getJSONObject(i))
                    })
                })
            }
        }
        return sections
    }

    fun getUpNext(videoId: String?, fallbackQuery: String): JSONArray {
        val results = mutableListOf<JSONObject>()
        val seen = mutableSetOf<String>()
        if (!videoId.isNullOrBlank()) seen.add(videoId)

        if (!videoId.isNullOrBlank()) {
            try {
                val payload = JSONObject().apply {
                    put("context", ytmContext())
                    put("videoId", videoId)
                    put("playlistId", "RDAMVM$videoId")
                    put("isAudioOnly", true)
                }.toString()
                val (code, text) = httpRequest(
                    "https://music.youtube.com/youtubei/v1/next?prettyPrint=false",
                    "POST",
                    payload,
                    mapOf("Origin" to "https://music.youtube.com", "Referer" to "https://music.youtube.com/")
                )
                if (code in 200..299) {
                    collectYtmItems(JSONObject(text), "audio", results, seen)
                }
            } catch (_: Exception) { }
        }

        if (results.isEmpty() && fallbackQuery.isNotBlank()) {
            return searchMusic(fallbackQuery, "songs")
        }
        return JSONArray().apply { results.take(20).forEach { put(it) } }
    }

    fun getLyrics(title: String, artist: String, album: String, duration: Int): JSONObject {
        val out = JSONObject().apply {
            put("syncedLyrics", JSONObject.NULL)
            put("plainLyrics", JSONObject.NULL)
            put("source", JSONObject.NULL)
        }
        val cleanTitle = title.replace(Regex("\\(Official.*?\\)|\\[Official.*?\\]|\\(Lyrics.*?\\)|\\[Lyrics.*?\\]|\\(Audio.*?\\)", RegexOption.IGNORE_CASE), "").trim()
        val cleanArtist = artist.split(",").firstOrNull()?.trim() ?: ""
        if (cleanTitle.isEmpty()) return out

        try {
            val sb = StringBuilder("https://lrclib.net/api/get?track_name=${URLEncoder.encode(cleanTitle, "UTF-8")}")
            if (cleanArtist.isNotBlank() && cleanArtist != "Unknown Artist") {
                sb.append("&artist_name=${URLEncoder.encode(cleanArtist, "UTF-8")}")
            }
            if (album.isNotBlank()) sb.append("&album_name=${URLEncoder.encode(album, "UTF-8")}")
            if (duration > 0) sb.append("&duration=$duration")

            val (code, text) = httpRequest(sb.toString(), "GET", null, mapOf("User-Agent" to "YumaPlayer-Android/1.4.0"), 5500)
            if (code in 200..299) {
                val d = JSONObject(text)
                if (!d.isNull("syncedLyrics") || !d.isNull("plainLyrics")) {
                    out.put("syncedLyrics", d.opt("syncedLyrics"))
                    out.put("plainLyrics", d.opt("plainLyrics"))
                    out.put("source", "LRCLIB")
                    return out
                }
            }

            val q = if (cleanArtist.isNotBlank() && cleanArtist != "Unknown Artist") "$cleanTitle $cleanArtist" else cleanTitle
            val (sCode, sText) = httpRequest(
                "https://lrclib.net/api/search?q=${URLEncoder.encode(q, "UTF-8")}",
                "GET", null, mapOf("User-Agent" to "YumaPlayer-Android/1.4.0"), 5500
            )
            if (sCode in 200..299) {
                val arr = JSONArray(sText)
                if (arr.length() > 0) {
                    var best = arr.getJSONObject(0)
                    for (i in 0 until arr.length()) {
                        val item = arr.getJSONObject(i)
                        if (!item.isNull("syncedLyrics") && item.optString("syncedLyrics").isNotBlank()) {
                            best = item
                            break
                        }
                    }
                    out.put("syncedLyrics", best.opt("syncedLyrics"))
                    out.put("plainLyrics", best.opt("plainLyrics"))
                    out.put("source", "LRCLIB")
                }
            }
        } catch (_: Exception) { }
        return out
    }

    fun getSponsorSegments(videoId: String): JSONArray {
        val out = JSONArray()
        if (videoId.isBlank()) return out
        try {
            val url = "https://sponsor.ajay.app/api/skipSegments?videoID=${URLEncoder.encode(videoId, "UTF-8")}&category=sponsor&category=intro&category=outro&category=music_offtopic"
            val (code, text) = httpRequest(url, "GET", null, emptyMap(), 4500)
            if (code in 200..299) {
                val arr = JSONArray(text)
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val seg = item.optJSONArray("segment") ?: continue
                    if (seg.length() == 2) {
                        out.put(JSONObject().apply {
                            put("start", seg.optDouble(0, 0.0))
                            put("end", seg.optDouble(1, 0.0))
                            put("category", item.optString("category", "music_offtopic"))
                        })
                    }
                }
            }
        } catch (_: Exception) { }
        return out
    }

    fun checkUpdates(currentVersion: String): JSONObject {
        val res = JSONObject().apply {
            put("currentVersion", currentVersion)
            put("state", "up-to-date")
            put("message", "Up to date (v$currentVersion)")
        }
        try {
            val (code, text) = httpRequest(
                "https://api.github.com/repos/pavithran-mist/YumaPlayer-PC/releases/latest",
                "GET", null, mapOf("Accept" to "application/vnd.github+json"), 6500
            )
            if (code in 200..299) {
                val rel = JSONObject(text)
                val tag = rel.optString("tag_name", "").removePrefix("v")
                res.put("latestTag", tag)
                res.put("notes", rel.optString("body", "").take(700))
                val assets = rel.optJSONArray("assets") ?: JSONArray()
                var apkUrl = ""
                var apkName = ""
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    val name = a.optString("name", "")
                    if (name.endsWith(".apk", ignoreCase = true)) {
                        apkUrl = a.optString("browser_download_url", "")
                        apkName = name
                        break
                    }
                }
                if (tag.isNotBlank() && compareSemver(tag, currentVersion) > 0 && apkUrl.isNotBlank()) {
                    res.put("state", "available")
                    res.put("availableVersion", tag)
                    res.put("apkUrl", apkUrl)
                    res.put("apkName", apkName)
                    res.put("message", "Update v$tag available for in-app install!")
                }
            }
            val (uCode, uText) = httpRequest(
                "https://api.github.com/repos/MuwMx/YumaPlayer/releases/latest",
                "GET", null, mapOf("Accept" to "application/vnd.github+json"), 5000
            )
            if (uCode in 200..299) {
                val uRel = JSONObject(uText)
                res.put("upstream", JSONObject().apply {
                    put("tag", uRel.optString("tag_name", ""))
                    put("name", uRel.optString("name", ""))
                })
            }
        } catch (_: Exception) { }
        return res
    }

    private fun compareSemver(a: String, b: String): Int {
        val pa = a.split(Regex("[-.]")).take(3).map { it.toIntOrNull() ?: 0 }
        val pb = b.split(Regex("[-.]")).take(3).map { it.toIntOrNull() ?: 0 }
        for (i in 0..2) {
            val av = pa.getOrElse(i) { 0 }
            val bv = pb.getOrElse(i) { 0 }
            if (av > bv) return 1
            if (av < bv) return -1
        }
        return 0
    }
}
