package com.pavithran.yumaplayer

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var rootContainer: FrameLayout
    private lateinit var uiWebView: WebView
    private lateinit var ytmWebView: BackgroundWebView
    private lateinit var mediaServer: LocalMediaServer

    private val executor = Executors.newCachedThreadPool()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var currentVideoId: String? = null
    private var lastEndedSentFor: String? = null
    private var isLoadingTrack = false
    private var targetVolume = 0.85
    private var targetRate = 1.0
    private var pollRunnable: Runnable? = null

    private var pendingPickCallbackId: String? = null

    private val docPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        val cbId = pendingPickCallbackId ?: return@registerForActivityResult
        pendingPickCallbackId = null
        executor.execute {
            val arr = JSONArray()
            for (uri in uris) {
                try {
                    contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Exception) { }
                buildTrackFromUri(uri)?.let { arr.put(it) }
            }
            sendCallback(cbId, arr.toString())
        }
    }

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        scanAndPushLocalLibrary()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.statusBarColor = 0xFF000000.toInt()
        window.navigationBarColor = 0xFF000000.toInt()

        mediaServer = LocalMediaServer(this).also { it.start() }

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(0xFF000000.toInt())
        }
        setContentView(rootContainer)

        uiWebView = WebView(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            addJavascriptInterface(YumaAndroidBridge(), "YumaAndroid")
        }

        ytmWebView = BackgroundWebView(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString =
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    injectCleanVideoCss()
                    if (!isLoadingTrack && currentVideoId != null && url != null) {
                        checkUnexpectedNavigation(url)
                    }
                }

                override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                    super.doUpdateVisitedHistory(view, url, isReload)
                    if (!isLoadingTrack && currentVideoId != null && url != null) {
                        checkUnexpectedNavigation(url)
                    }
                }
            }
        }

        rootContainer.addView(
            uiWebView,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )
        rootContainer.addView(ytmWebView, FrameLayout.LayoutParams(1, 1).apply {
            leftMargin = -2000
            topMargin = -2000
        })

        YumaMediaService.onMediaAction = { cmd ->
            runOnUiThread {
                uiWebView.evaluateJavascript("window.__onAndroidMediaCmd && window.__onAndroidMediaCmd(${JSONObject.quote(cmd)})", null)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                uiWebView.evaluateJavascript("window.__onAndroidBack && window.__onAndroidBack()", null)
            }
        })

        requestRuntimePermissionsIfNeeded()
        uiWebView.loadUrl("file:///android_asset/www/index.html")
    }

    private fun checkUnexpectedNavigation(url: String) {
        val expected = currentVideoId ?: return
        try {
            val v = Uri.parse(url).getQueryParameter("v")
            if (!v.isNullOrBlank() && v != expected && lastEndedSentFor != expected) {
                lastEndedSentFor = expected
                stopPolling()
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.pause(); })()", null)
                pushYtmState(expected, 0.0, 0.0, paused = true, ended = true, isAd = false)
            }
        } catch (_: Exception) { }
    }

    private fun injectCleanVideoCss() {
        val js = """
            (() => {
              if (document.getElementById('yuma-clean-css')) return;
              const st = document.createElement('style');
              st.id = 'yuma-clean-css';
              st.textContent = `
                html, body { background: #000 !important; overflow: hidden !important; margin: 0 !important; }
                ytm-mobile-topbar-renderer, ytm-pivot-bar-renderer, ytm-item-section-renderer,
                ytmusic-nav-bar, ytmusic-player-bar, .ytp-chrome-top, .ytp-watermark { display: none !important; }
                #player-container-id, #player, ytmusic-player, #movie_player, video.html5-main-video {
                  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
                  object-fit: contain !important; background: #000 !important; z-index: 9999 !important;
                }
              `;
              document.head.appendChild(st);
            })();
        """.trimIndent()
        ytmWebView.evaluateJavascript(js, null)
    }

    private fun requestRuntimePermissionsIfNeeded() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.READ_MEDIA_AUDIO)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.READ_MEDIA_VIDEO)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
        if (needed.isNotEmpty()) {
            permLauncher.launch(needed.toTypedArray())
        }
    }

    private fun scanAndPushLocalLibrary() {
        executor.execute {
            val arr = scanDeviceMediaFiles()
            runOnUiThread {
                uiWebView.evaluateJavascript("window.__onLocalLibraryScanned && window.__onLocalLibraryScanned(${JSONObject.quote(arr.toString())})", null)
            }
        }
    }

    private fun scanDeviceMediaFiles(): JSONArray {
        val out = JSONArray()
        val audioProj = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DISPLAY_NAME
        )
        try {
            contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                audioProj, null, null, "${MediaStore.Audio.Media.TITLE} ASC"
            )?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val titleCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val artCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                val albCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
                val durCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                var count = 0
                while (c.moveToNext() && count < 250) {
                    val id = c.getLong(idCol)
                    val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
                    val fileName = c.getString(nameCol) ?: "track"
                    val ext = fileName.substringAfterLast(".", "AUDIO").uppercase()
                    out.put(JSONObject().apply {
                        put("id", "local_$id")
                        put("source", "local")
                        put("mediaType", "audio")
                        put("title", c.getString(titleCol)?.takeIf { it.isNotBlank() } ?: fileName)
                        put("artist", c.getString(artCol)?.takeIf { it != "<unknown>" } ?: "Unknown Artist")
                        put("album", c.getString(albCol) ?: "Device Audio")
                        put("duration", (c.getLong(durCol) / 1000L).toInt())
                        put("artwork", "")
                        put("filePath", uri.toString())
                        put("codec", ext)
                        put("lossless", ext == "FLAC" || ext == "WAV" || ext == "ALAC")
                    })
                    count++
                }
            }
        } catch (_: Exception) { }

        val vidProj = arrayOf(
            MediaStore.Video.Media._ID,
            MediaStore.Video.Media.TITLE,
            MediaStore.Video.Media.DURATION,
            MediaStore.Video.Media.DISPLAY_NAME
        )
        try {
            contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                vidProj, null, null, "${MediaStore.Video.Media.TITLE} ASC"
            )?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
                val titleCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.TITLE)
                val durCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME)
                var count = 0
                while (c.moveToNext() && count < 100) {
                    val id = c.getLong(idCol)
                    val uri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id)
                    val fileName = c.getString(nameCol) ?: "video"
                    val ext = fileName.substringAfterLast(".", "MP4").uppercase()
                    out.put(JSONObject().apply {
                        put("id", "local_v_$id")
                        put("source", "local")
                        put("mediaType", "video")
                        put("title", c.getString(titleCol)?.takeIf { it.isNotBlank() } ?: fileName)
                        put("artist", "Device Video")
                        put("album", "Local Videos")
                        put("duration", (c.getLong(durCol) / 1000L).toInt())
                        put("artwork", "")
                        put("filePath", uri.toString())
                        put("codec", ext)
                        put("lossless", false)
                    })
                    count++
                }
            }
        } catch (_: Exception) { }

        return out
    }

    private fun buildTrackFromUri(uri: Uri): JSONObject? {
        var name = "Media File"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) name = c.getString(0) ?: name
        }
        val mime = contentResolver.getType(uri) ?: ""
        val isVideo = mime.startsWith("video/") || name.endsWith(".mp4", true) || name.endsWith(".mkv", true) || name.endsWith(".webm", true)
        val ext = name.substringAfterLast(".", if (isVideo) "MP4" else "MP3").uppercase()
        val title = name.substringBeforeLast(".")
        return JSONObject().apply {
            put("id", "uri_${uri.toString().hashCode()}")
            put("source", "local")
            put("mediaType", if (isVideo) "video" else "audio")
            put("title", title)
            put("artist", "Local File")
            put("album", "Picked Media")
            put("duration", 0)
            put("artwork", "")
            put("filePath", uri.toString())
            put("codec", ext)
            put("lossless", ext == "FLAC" || ext == "WAV" || ext == "ALAC")
        }
    }

    private fun startPolling(videoId: String) {
        stopPolling()
        val runnable = object : Runnable {
            override fun run() {
                if (currentVideoId != videoId) return
                val js = """
                    (() => {
                      const expectedId = ${JSONObject.quote(videoId)};
                      const pageV = new URLSearchParams(location.search).get('v');
                      const v = document.querySelector('video');
                      if (pageV && pageV !== expectedId) {
                        if (v) v.pause();
                        return JSON.stringify({ isAd: false, currentTime: 0, duration: 0, paused: true, ended: true });
                      }
                      if (!v) return null;
                      if (!v.__yumaHookedFor || v.__yumaHookedFor !== expectedId) {
                        v.__yumaHookedFor = expectedId;
                        window.__yumaEndedForId = null;
                        v.addEventListener('ended', () => {
                          window.__yumaEndedForId = expectedId;
                          v.pause();
                        });
                      }
                      const player = document.querySelector('#movie_player');
                      const isAd = Boolean(player && player.classList.contains('ad-showing'));
                      if (isAd) {
                        v.muted = true;
                        const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button');
                        if (skipBtn) skipBtn.click();
                        return JSON.stringify({ isAd: true, currentTime: 0, duration: 0, paused: false, ended: false });
                      }
                      if (v.muted) v.muted = false;
                      if (Math.abs(v.volume - $targetVolume) > 0.02) v.volume = $targetVolume;
                      if (Math.abs(v.playbackRate - $targetRate) > 0.02) v.playbackRate = $targetRate;
                      const dur = Number.isFinite(v.duration) ? v.duration : 0;
                      const cur = v.currentTime || 0;
                      const hasEnded = window.__yumaEndedForId === expectedId || v.ended || (dur > 5 && cur >= dur - 0.35);
                      if (hasEnded) v.pause();
                      return JSON.stringify({ isAd: false, currentTime: cur, duration: dur, paused: hasEnded ? true : v.paused, ended: hasEnded });
                    })();
                """.trimIndent()

                ytmWebView.evaluateJavascript(js) { raw ->
                    if (currentVideoId != videoId || raw == null || raw == "null") return@evaluateJavascript
                    try {
                        val unquoted = JSONObject("{\"v\":$raw}").optString("v", "")
                        if (unquoted.isBlank()) return@evaluateJavascript
                        val st = JSONObject(unquoted)
                        val ended = st.optBoolean("ended", false)
                        if (ended) {
                            if (lastEndedSentFor != videoId) {
                                lastEndedSentFor = videoId
                                stopPolling()
                                pushYtmState(videoId, st.optDouble("currentTime"), st.optDouble("duration"), true, true, false)
                            }
                        } else {
                            pushYtmState(
                                videoId,
                                st.optDouble("currentTime"),
                                st.optDouble("duration"),
                                st.optBoolean("paused"),
                                false,
                                st.optBoolean("isAd")
                            )
                        }
                    } catch (_: Exception) { }
                }
                mainHandler.postDelayed(this, 300)
            }
        }
        pollRunnable = runnable
        mainHandler.postDelayed(runnable, 500)
    }

    private fun stopPolling() {
        pollRunnable?.let { mainHandler.removeCallbacks(it) }
        pollRunnable = null
    }

    private fun pushYtmState(videoId: String, cur: Double, dur: Double, paused: Boolean, ended: Boolean, isAd: Boolean) {
        val payload = JSONObject().apply {
            put("videoId", videoId)
            put("currentTime", cur)
            put("duration", dur)
            put("paused", paused)
            put("ended", ended)
            put("isAd", isAd)
        }.toString()
        uiWebView.evaluateJavascript("window.__onYtmState && window.__onYtmState($payload)", null)
    }

    private fun sendCallback(reqId: String, jsonStr: String) {
        runOnUiThread {
            uiWebView.evaluateJavascript(
                "window.__yumaResolveCallback && window.__yumaResolveCallback(${JSONObject.quote(reqId)}, ${JSONObject.quote(jsonStr)})",
                null
            )
        }
    }

    inner class YumaAndroidBridge {
        @JavascriptInterface
        fun getConfig(): String {
            return JSONObject().apply {
                put("streamPort", mediaServer.port)
                put("version", "1.4.1")
                put("platform", "android")
            }.toString()
        }

        @JavascriptInterface
        fun storeGet(): String {
            val prefs = getSharedPreferences("yumaplayer_store", MODE_PRIVATE)
            return prefs.getString("data", "{}") ?: "{}"
        }

        @JavascriptInterface
        fun storeSet(json: String) {
            getSharedPreferences("yumaplayer_store", MODE_PRIVATE).edit().putString("data", json).apply()
        }

        @JavascriptInterface
        fun searchMusic(reqId: String, query: String, mode: String) {
            executor.execute {
                val res = YumaApiClient.searchMusic(query, mode)
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun getHomeDiscovery(reqId: String) {
            executor.execute {
                val res = YumaApiClient.getHomeDiscovery()
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun getUpNext(reqId: String, videoId: String, fallbackQuery: String) {
            executor.execute {
                val res = YumaApiClient.getUpNext(videoId.ifBlank { null }, fallbackQuery)
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun getLyrics(reqId: String, title: String, artist: String, album: String, duration: Int) {
            executor.execute {
                val res = YumaApiClient.getLyrics(title, artist, album, duration)
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun getSponsorSegments(reqId: String, videoId: String) {
            executor.execute {
                val res = YumaApiClient.getSponsorSegments(videoId)
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun scanLocalMedia(reqId: String) {
            executor.execute {
                val res = scanDeviceMediaFiles()
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun pickMediaFiles(reqId: String) {
            runOnUiThread {
                pendingPickCallbackId = reqId
                docPickerLauncher.launch(arrayOf("audio/*", "video/*"))
            }
        }

        @JavascriptInterface
        fun ytmPlay(videoId: String, preferVideo: Boolean) {
            runOnUiThread {
                currentVideoId = videoId
                lastEndedSentFor = null
                isLoadingTrack = true
                stopPolling()
                val url = if (preferVideo) {
                    "https://www.youtube.com/watch?v=${URLEncoder.encode(videoId, "UTF-8")}"
                } else {
                    "https://music.youtube.com/watch?v=${URLEncoder.encode(videoId, "UTF-8")}"
                }
                ytmWebView.loadUrl(url)
                mainHandler.postDelayed({
                    isLoadingTrack = false
                    if (currentVideoId == videoId) startPolling(videoId)
                }, 1400)
            }
        }

        @JavascriptInterface
        fun ytmPause() {
            runOnUiThread {
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.pause(); })()", null)
            }
        }

        @JavascriptInterface
        fun ytmResume() {
            runOnUiThread {
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.play(); })()", null)
            }
        }

        @JavascriptInterface
        fun ytmStop() {
            runOnUiThread {
                stopPolling()
                currentVideoId = null
                isLoadingTrack = false
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.pause(); })()", null)
                ytmWebView.loadUrl("about:blank")
                setVideoStage(false, 0f, 0f, 0f, 0f)
            }
        }

        @JavascriptInterface
        fun ytmSeek(seconds: Double) {
            runOnUiThread {
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v && Number.isFinite(v.duration)) v.currentTime = $seconds; })()", null)
            }
        }

        @JavascriptInterface
        fun ytmSetVolume(vol: Double) {
            targetVolume = vol.coerceIn(0.0, 1.0)
            runOnUiThread {
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.volume = $targetVolume; })()", null)
            }
        }

        @JavascriptInterface
        fun ytmSetRate(rate: Double) {
            targetRate = rate.coerceIn(0.5, 2.0)
            runOnUiThread {
                ytmWebView.evaluateJavascript("(() => { const v = document.querySelector('video'); if (v) v.playbackRate = $targetRate; })()", null)
            }
        }

        @JavascriptInterface
        fun setVideoStage(visible: Boolean, xCss: Float, yCss: Float, wCss: Float, hCss: Float) {
            runOnUiThread {
                val density = resources.displayMetrics.density
                val lp = ytmWebView.layoutParams as FrameLayout.LayoutParams
                if (visible && wCss > 20f && hCss > 20f) {
                    lp.width = (wCss * density).toInt()
                    lp.height = (hCss * density).toInt()
                    lp.leftMargin = (xCss * density).toInt()
                    lp.topMargin = (yCss * density).toInt()
                    ytmWebView.visibility = View.VISIBLE
                } else {
                    lp.width = 1
                    lp.height = 1
                    lp.leftMargin = -2000
                    lp.topMargin = -2000
                }
                ytmWebView.layoutParams = lp
            }
        }

        @JavascriptInterface
        fun setFullscreen(enabled: Boolean) {
            runOnUiThread {
                if (enabled) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    @Suppress("DEPRECATION")
                    window.decorView.systemUiVisibility = (
                        View.SYSTEM_UI_FLAG_FULLSCREEN or
                            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        )
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    @Suppress("DEPRECATION")
                    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
                }
            }
        }

        @JavascriptInterface
        fun updateMediaNotification(title: String, artist: String, playing: Boolean) {
            val i = Intent(this@MainActivity, YumaMediaService::class.java).apply {
                action = YumaMediaService.ACTION_UPDATE
                putExtra(YumaMediaService.EXTRA_TITLE, title)
                putExtra(YumaMediaService.EXTRA_ARTIST, artist)
                putExtra(YumaMediaService.EXTRA_PLAYING, playing)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
        }

        @JavascriptInterface
        fun checkUpdates(reqId: String) {
            executor.execute {
                val res = YumaApiClient.checkUpdates("1.4.1")
                sendCallback(reqId, res.toString())
            }
        }

        @JavascriptInterface
        fun downloadAndInstallUpdate(apkUrl: String, apkName: String) {
            executor.execute {
                try {
                    emitUpdateProgress("downloading", 0, "Downloading $apkName...")
                    val conn = (URL(apkUrl).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = true
                        connectTimeout = 15000
                        readTimeout = 30000
                        setRequestProperty("User-Agent", "YumaPlayer-Android/1.4.0")
                    }
                    val total = conn.contentLengthLong.coerceAtLeast(1L)
                    val outFile = File(cacheDir, apkName.ifBlank { "YumaPlayer-Update.apk" })
                    conn.inputStream.use { input ->
                        FileOutputStream(outFile).use { fos ->
                            val buf = ByteArray(16384)
                            var received = 0L
                            var lastPct = -1
                            while (true) {
                                val r = input.read(buf)
                                if (r <= 0) break
                                fos.write(buf, 0, r)
                                received += r
                                val pct = ((received * 100) / total).toInt().coerceIn(0, 99)
                                if (pct != lastPct) {
                                    lastPct = pct
                                    emitUpdateProgress("downloading", pct, "Downloading update: $pct%")
                                }
                            }
                        }
                    }
                    emitUpdateProgress("downloaded", 100, "Installing update...")
                    val contentUri = FileProvider.getUriForFile(
                        this@MainActivity,
                        "${packageName}.fileprovider",
                        outFile
                    )
                    val installIntent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(contentUri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    runOnUiThread { startActivity(installIntent) }
                } catch (e: Exception) {
                    emitUpdateProgress("error", 0, "Update failed: ${e.message}")
                }
            }
        }
    }

    private fun emitUpdateProgress(state: String, progress: Int, message: String) {
        val obj = JSONObject().apply {
            put("currentVersion", "1.4.1")
            put("state", state)
            put("progress", progress)
            put("message", message)
        }.toString()
        runOnUiThread {
            uiWebView.evaluateJavascript("window.__onAndroidUpdateStatus && window.__onAndroidUpdateStatus($obj)", null)
        }
    }

    override fun onDestroy() {
        stopPolling()
        mediaServer.stop()
        ytmWebView.destroy()
        super.onDestroy()
    }
}
