export class Player {
  constructor({ onProgress, onSelect }) {
    this.current = null;
    this.playing = false;
    this.progress = 0;
    this.startedAt = 0;
    this.startedAtAudio = 0;
    this.audioContext = null;
    this.sources = [];
    this.decodeCache = new Map();
    this.activeDecode = null;
    this.activeDuration = 1;
    this.onProgress = onProgress;
    this.onSelect = onSelect;
    this.raf = 0;
  }

  load(record, autoplay = false) {
    this.stopSources();
    this.current = record;
    this.progress = 0;
    this.activeDuration = record.duration || 1;
    this.onSelect(record);
    if (autoplay) this.play();
    else this.pause();
  }

  play() {
    if (!this.current) return;
    this.playing = true;
    this.startedAt = performance.now() - this.progress * this.getDuration() * 1000;
    const context = this.getAudioContext();
    context.resume?.();
    this.startDecodedAudio(this.current, this.progress);
    this.tick();
  }

  pause() {
    this.playing = false;
    this.stopSources();
    cancelAnimationFrame(this.raf);
    this.onProgress(this.progress, this.playing);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  scrub(value) {
    this.progress = Math.max(0, Math.min(1, value));
    if (this.playing && this.current) {
      this.startedAt = performance.now() - this.progress * this.getDuration() * 1000;
      this.startDecodedAudio(this.current, this.progress);
    }
    this.onProgress(this.progress, this.playing);
  }

  tick() {
    if (!this.playing || !this.current) return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.progress = (elapsed % this.getDuration()) / this.getDuration();
    this.onProgress(this.progress, this.playing);
    this.raf = requestAnimationFrame(() => this.tick());
  }

  async prepare(record) {
    const context = this.getAudioContext();
    await context.resume?.();
    const decoded = await this.decodeRecord(record, context);
    if (!this.current || this.current.id === record.id) {
      this.activeDuration = decoded.duration || record.duration || 1;
    }
    return decoded;
  }

  getDuration() {
    return this.activeDuration || this.current?.duration || 1;
  }

  getAudioContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }
    return this.audioContext;
  }

  stopSources() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Source nodes throw when stopped twice; stopping is best effort.
      }
    }
    this.sources = [];
  }

  async startDecodedAudio(record, progress) {
    const decodeToken = {};
    this.activeDecode = decodeToken;
    const context = this.getAudioContext();
    this.stopSources();
    let decoded;
    try {
      decoded = await this.decodeRecord(record, context);
    } catch (error) {
      this.playing = false;
      cancelAnimationFrame(this.raf);
      this.onProgress(this.progress, this.playing);
      console.error(error);
      return;
    }
    if (this.activeDecode !== decodeToken || this.current?.id !== record.id || !this.playing) return;

    this.activeDuration = decoded.duration || record.duration || 1;
    const offset = Math.max(0, Math.min(this.activeDuration, progress * this.activeDuration));
    this.startedAt = performance.now() - offset * 1000;
    this.startedAtAudio = context.currentTime - offset;
    const startAt = context.currentTime + 0.01;
    this.sources = decoded.buffers.map((buffer) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(context.destination);
      source.start(startAt, Math.min(offset, Math.max(0, buffer.duration - 0.001)));
      return source;
    });
  }

  decodeRecord(record, context) {
    const cacheKey = `${record.id}:${context.sampleRate}`;
    if (!this.decodeCache.has(cacheKey)) {
      this.decodeCache.set(cacheKey, decodeRecordAudio(record, context));
    }
    return this.decodeCache.get(cacheKey);
  }
}

function loadImageData(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error(`Unable to load encoded audio image: ${src}`));
    image.src = src;
  });
}

async function decodeRecordAudio(record, context) {
  if (!window.StegCore) throw new Error("StegCore is not loaded");
  const imageData = await loadImageData(record.imageUrl);
  const encImg = new window.StegCore.Img(imageData.width, imageData.height, new Uint8Array(imageData.data));
  const { entries } = window.StegCore.decodeContainer(encImg, encImg);
  const audioEntries = entries.filter((entry) => entry.mimetype.startsWith("audio/"));
  if (!audioEntries.length) throw new Error(`No audio entry found in ${record.imageUrl}`);

  const buffers = audioEntries.map((entry) => {
    const { bits, rate, channels, layout, blockSize } = window.StegCore.parseAudioMime(entry.mimetype);
    const rawF32 = window.StegCore.toFloat32(entry.data, bits);
    const planarF32 = window.StegCore.unlayoutChannels({
      f32: rawF32,
      layout,
      channels,
      blockSize,
    });
    const samplesPerChannel = Math.floor(planarF32.length / channels);
    const buffer = context.createBuffer(channels, samplesPerChannel, rate);
    for (let ch = 0; ch < channels; ch += 1) {
      const channel = buffer.getChannelData(ch);
      const offset = ch * samplesPerChannel;
      for (let i = 0; i < samplesPerChannel; i += 1) channel[i] = planarF32[offset + i];
    }
    return buffer;
  });

  return {
    buffers,
    duration: Math.max(...buffers.map((buffer) => buffer.duration)),
  };
}
