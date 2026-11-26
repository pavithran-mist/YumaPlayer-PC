(function (root) {
  const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 1, 2, 2],
    'Hi-Res Studio': [2, 1.5, 0.5, 0, 0, 0.5, 1.5, 2.5, 3, 2.5],
    'Vocal Clarity': [-2, -1, 0, 1, 3, 4, 3.5, 2, 1, 0],
    'Club / EDM': [5, 4.5, 2, 0, -1, 0, 2, 3.5, 4, 4],
    'Late Night': [-3, -1, 1, 2, 1.5, 1, 0, -1, -2, -3]
  };

  function computeCrossfadeGains(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return {
      outgoing: Math.cos(t * Math.PI * 0.5),
      incoming: Math.sin(t * Math.PI * 0.5)
    };
  }

  class DualDeckAudioEngine {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.ctx = null;
      this.decks = [];
      this.activeDeckIndex = 0;
      this.eqFilters = [];
      this.preampNode = null;
      this.masterGain = null;
      this.analyser = null;
      this.crossfadeSeconds = 4;
      this.bassSwap = true;
      this.volume = 0.85;
      this.preampDb = 0;
      this.eqBands = [...EQ_PRESETS.Flat];
      this.crossfadeTimer = null;
      this.isCrossfading = false;
      this.crossfadeTriggeredForTrack = false;
      this.visualizerData = null;
    }

    init() {
      if (this.ctx) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      this.preampNode = this.ctx.createGain();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.78;
      this.visualizerData = new Uint8Array(this.analyser.frequencyBinCount);

      // Build 10-band EQ chain
      let prevNode = this.preampNode;
      this.eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
        const filter = this.ctx.createBiquadFilter();
        filter.type = idx === 0 ? 'lowshelf' : idx === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.2;
        filter.gain.value = this.eqBands[idx] || 0;
        prevNode.connect(filter);
        prevNode = filter;
        return filter;
      });

      prevNode.connect(this.masterGain);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.decks = [0, 1].map((idx) => this._createDeck(idx));
      this._setPreampDb(this.preampDb);
    }

    _createDeck(index) {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';

      const source = this.ctx.createMediaElementSource(audio);
      const bassFilter = this.ctx.createBiquadFilter();
      bassFilter.type = 'lowshelf';
      bassFilter.frequency.value = 180;
      bassFilter.gain.value = 0;

      const gain = this.ctx.createGain();
      gain.gain.value = index === 0 ? 1 : 0;

      source.connect(bassFilter);
      bassFilter.connect(gain);
      gain.connect(this.preampNode);

      const deck = { index, audio, source, bassFilter, gain };

      audio.addEventListener('timeupdate', () => {
        if (this.activeDeckIndex !== index) return;
        const currentTime = audio.currentTime || 0;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        this.callbacks.onTimeUpdate?.(currentTime, duration);

        if (
          this.crossfadeSeconds > 0 &&
          duration > this.crossfadeSeconds + 4 &&
          !this.crossfadeTriggeredForTrack &&
          !this.isCrossfading &&
          duration - currentTime <= this.crossfadeSeconds
        ) {
          this.crossfadeTriggeredForTrack = true;
          this.callbacks.onCrossfadeTrigger?.();
        }
      });

      audio.addEventListener('ended', () => {
        if (this.activeDeckIndex === index && !this.isCrossfading) {
          this.callbacks.onEnded?.();
        }
      });

      audio.addEventListener('play', () => {
        if (this.activeDeckIndex === index) {
          this.callbacks.onPlayStateChange?.(true);
        }
      });

      audio.addEventListener('pause', () => {
        if (this.activeDeckIndex === index && !this.isCrossfading) {
          this.callbacks.onPlayStateChange?.(false);
        }
      });

      audio.addEventListener('error', () => {
        if (this.activeDeckIndex === index) {
          this.callbacks.onError?.('Unable to decode or stream this audio source.');
        }
      });

      return deck;
    }

    async _ensureResumed() {
      this.init();
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
    }

    _cancelCrossfade() {
      if (this.crossfadeTimer) {
        clearInterval(this.crossfadeTimer);
        this.crossfadeTimer = null;
      }
      this.isCrossfading = false;
    }

    async playUrl(url, { useCrossfade = false } = {}) {
      await this._ensureResumed();

      const currentDeck = this.decks[this.activeDeckIndex];
      const nextIndex = this.activeDeckIndex === 0 ? 1 : 0;
      const nextDeck = this.decks[nextIndex];

      if (!useCrossfade || this.crossfadeSeconds <= 0 || currentDeck.audio.paused) {
        this._cancelCrossfade();
        currentDeck.audio.pause();
        currentDeck.audio.src = '';
        currentDeck.gain.gain.value = 0;
        currentDeck.bassFilter.gain.value = 0;

        this.activeDeckIndex = nextIndex;
        this.crossfadeTriggeredForTrack = false;
        nextDeck.gain.gain.value = 1;
        nextDeck.bassFilter.gain.value = 0;
        nextDeck.audio.src = url;
        await nextDeck.audio.play();
        return;
      }

      // Dual-deck equal-power crossfade (+ optional smart bass-swap)
      this._cancelCrossfade();
      this.isCrossfading = true;
      this.crossfadeTriggeredForTrack = false;

      nextDeck.gain.gain.value = 0;
      nextDeck.bassFilter.gain.value = this.bassSwap ? -14 : 0;
      nextDeck.audio.src = url;
      await nextDeck.audio.play();

      const totalMs = this.crossfadeSeconds * 1000;
      const startTime = performance.now();
      this.activeDeckIndex = nextIndex;

      this.crossfadeTimer = setInterval(() => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / totalMs);
        const { outgoing, incoming } = computeCrossfadeGains(progress);

        currentDeck.gain.gain.value = outgoing;
        nextDeck.gain.gain.value = incoming;

        if (this.bassSwap) {
          currentDeck.bassFilter.gain.value = -14 * progress;
          nextDeck.bassFilter.gain.value = -14 * (1 - progress);
        }

        if (progress >= 1) {
          this._cancelCrossfade();
          currentDeck.audio.pause();
          currentDeck.audio.src = '';
          currentDeck.gain.gain.value = 0;
          currentDeck.bassFilter.gain.value = 0;
          nextDeck.bassFilter.gain.value = 0;
          nextDeck.gain.gain.value = 1;
        }
      }, 40);
    }

    get activeAudio() {
      return this.decks[this.activeDeckIndex]?.audio || null;
    }

    togglePlay() {
      const audio = this.activeAudio;
      if (!audio || !audio.src) return;
      if (audio.paused) {
        this._ensureResumed().then(() => audio.play());
      } else {
        audio.pause();
      }
    }

    seek(seconds) {
      const audio = this.activeAudio;
      if (!audio || !Number.isFinite(audio.duration)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    }

    setVolume(val) {
      this.volume = Math.max(0, Math.min(1, val));
      if (this.masterGain) {
        this.masterGain.gain.value = this.volume;
      }
    }

    setCrossfade(seconds, bassSwap) {
      this.crossfadeSeconds = Number(seconds) || 0;
      if (typeof bassSwap === 'boolean') this.bassSwap = bassSwap;
    }

    setEqBand(index, gainDb) {
      this.eqBands[index] = gainDb;
      if (this.eqFilters[index]) {
        this.eqFilters[index].gain.value = gainDb;
      }
    }

    setAllEqBands(bands) {
      if (!Array.isArray(bands)) return;
      bands.forEach((db, i) => this.setEqBand(i, db));
    }

    _setPreampDb(db) {
      this.preampDb = db;
      if (this.preampNode) {
        this.preampNode.gain.value = Math.pow(10, db / 20);
      }
    }

    getSpectrum() {
      if (!this.analyser || !this.visualizerData) return null;
      this.analyser.getByteFrequencyData(this.visualizerData);
      return this.visualizerData;
    }
  }

  const api = {
    EQ_FREQUENCIES,
    EQ_PRESETS,
    computeCrossfadeGains,
    DualDeckAudioEngine
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.YumaAudio = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
