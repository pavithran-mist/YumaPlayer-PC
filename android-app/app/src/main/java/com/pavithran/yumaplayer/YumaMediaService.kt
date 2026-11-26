package com.pavithran.yumaplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle

class YumaMediaService : Service() {

    companion object {
        const val CHANNEL_ID = "yuma_playback_channel"
        const val NOTIF_ID = 1001
        const val ACTION_UPDATE = "com.pavithran.yumaplayer.ACTION_UPDATE"
        const val ACTION_CMD = "com.pavithran.yumaplayer.ACTION_CMD"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_CMD = "cmd"

        var onMediaAction: ((String) -> Unit)? = null
    }

    private lateinit var mediaSession: MediaSessionCompat

    override fun onCreate() {
        super.onCreate()
        createChannel()
        mediaSession = MediaSessionCompat(this, "YumaPlayerSession").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { onMediaAction?.invoke("toggle") }
                override fun onPause() { onMediaAction?.invoke("toggle") }
                override fun onSkipToNext() { onMediaAction?.invoke("next") }
                override fun onSkipToPrevious() { onMediaAction?.invoke("prev") }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CMD -> {
                val cmd = intent.getStringExtra(EXTRA_CMD) ?: return START_NOT_STICKY
                onMediaAction?.invoke(cmd)
            }
            ACTION_UPDATE -> {
                val title = intent.getStringExtra(EXTRA_TITLE) ?: "YumaPlayer"
                val artist = intent.getStringExtra(EXTRA_ARTIST) ?: "by Pavithran"
                val playing = intent.getBooleanExtra(EXTRA_PLAYING, false)
                updateSession(title, artist, playing)
                startForeground(NOTIF_ID, buildNotification(title, artist, playing))
            }
            else -> {
                startForeground(NOTIF_ID, buildNotification("YumaPlayer", "by Pavithran", false))
            }
        }
        return START_STICKY
    }

    private fun updateSession(title: String, artist: String, playing: Boolean) {
        mediaSession.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .build()
        )
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                )
                .setState(state, 0L, 1.0f)
                .build()
        )
    }

    private fun cmdIntent(cmd: String, reqCode: Int): PendingIntent {
        val i = Intent(this, YumaMediaService::class.java).apply {
            action = ACTION_CMD
            putExtra(EXTRA_CMD, cmd)
        }
        return PendingIntent.getService(
            this, reqCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotification(title: String, artist: String, playing: Boolean): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val playPauseIcon = if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val playPauseLabel = if (playing) "Pause" else "Play"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(openIntent)
            .setOngoing(playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Previous", cmdIntent("prev", 1))
            .addAction(playPauseIcon, playPauseLabel, cmdIntent("toggle", 2))
            .addAction(android.R.drawable.ic_media_next, "Next", cmdIntent("next", 3))
            .setStyle(
                MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(CHANNEL_ID, "YumaPlayer Playback", NotificationManager.IMPORTANCE_LOW)
            mgr.createNotificationChannel(ch)
        }
    }

    override fun onDestroy() {
        mediaSession.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
