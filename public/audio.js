export const SOUND_PRESETS = [
  { id: 'wood', label: '木音', description: '轻短、温暖的敲击' },
  { id: 'glass', label: '玻璃', description: '清亮、有少许余韵' },
  { id: 'bell', label: '铃音', description: '柔和的双音泛音' },
  { id: 'low', label: '低音', description: '低沉、克制的回声' },
  { id: 'brush', label: '沙刷', description: '细密而短的颗粒' },
  { id: 'click', label: '微响', description: '干净的短促点击' },
  { id: 'mute', label: '静音', description: '保留记录，不播放' },
];

const MATCH_KEYS = new Set(['type', 'category', 'hookPoint', 'handlerId', 'toolName', 'skillName', 'outcome']);
const clamp = (value, fallback = 0.5) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;

export function matchSound(event, settings) {
  for (const rule of settings.rules || []) {
    if (!rule.enabled) continue;
    const entries = Object.entries(rule.match || {});
    if (!entries.every(([key, value]) => MATCH_KEYS.has(key) && value !== '' && event[key] != null && String(event[key]) === String(value))) continue;
    return { sound: rule.sound || 'mute', volume: clamp(rule.volume), ruleId: rule.id, reason: '精确规则' };
  }
  return { sound: settings.categorySounds?.[event.category] || 'mute', volume: 0.5, ruleId: null, reason: '类别默认' };
}

export class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.volume = 0.35;
    this.assets = new Map();
    this.buffers = new Map();
    this.voices = new Set();
    this.generation = 0;
  }

  async unlock() {
    const Constructor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Constructor) throw new Error('当前浏览器不支持 Web Audio，请使用较新的浏览器。');
    if (!this.context) {
      this.context = new Constructor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    }
    if (this.context.state !== 'running') await this.context.resume();
  }

  setVolume(value) {
    this.volume = clamp(value, 0.35);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
  }

  setAssets(assets) { this.assets = new Map(assets.map(asset => [asset.sound, asset])); }

  cancel() {
    this.generation++;
    for (const voice of [...this.voices]) this.stopVoice(voice);
  }

  stopVoice(voice) {
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, 0.012);
    for (const source of voice.sources) {
      try { source.stop(now + 0.06); } catch { /* Already ended. */ }
    }
    this.voices.delete(voice);
  }

  async play(sound, volume = 0.5) {
    if (sound === 'mute' || !this.context || this.context.state !== 'running') return false;
    const generation = this.generation;
    let buffer = null;
    if (sound.startsWith('asset:')) {
      const asset = this.assets.get(sound);
      if (!asset) throw new Error('这个本地音频已不可用，请重新上传。');
      if (!this.buffers.has(sound)) {
        const pending = fetch(asset.url).then(async response => {
          if (!response.ok) throw new Error('无法读取本地音频。');
          return this.context.decodeAudioData(await response.arrayBuffer());
        });
        this.buffers.set(sound, pending);
      }
      try { buffer = await this.buffers.get(sound); }
      catch (error) { this.buffers.delete(sound); throw new Error(`无法解码音频：${error.message}`); }
      if (generation !== this.generation) return false;
    }
    if (this.voices.size >= 8) this.stopVoice(this.voices.values().next().value);
    const context = this.context;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.connect(this.master);
    const voice = { gain, sources: [] };
    this.voices.add(voice);
    let duration = 0.25;
    const level = clamp(volume) * 0.45;
    const oscillator = (frequency, type, amount = 1, detune = null) => {
      const source = context.createOscillator();
      const layer = context.createGain();
      source.type = type;
      source.frequency.setValueAtTime(frequency, now);
      if (detune) source.frequency.exponentialRampToValueAtTime(detune, now + duration);
      layer.gain.value = amount;
      source.connect(layer).connect(gain);
      source.start(now);
      source.stop(now + duration + 0.03);
      voice.sources.push(source);
    };
    if (buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      duration = Math.min(buffer.duration, 8);
      source.start(now, 0, duration);
      voice.sources.push(source);
    } else if (sound === 'brush' || sound === 'click') {
      duration = sound === 'brush' ? 0.17 : 0.035;
      const noise = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const values = noise.getChannelData(0);
      for (let index = 0; index < values.length; index++) values[index] = (Math.random() * 2 - 1) * (1 - index / values.length);
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      source.buffer = noise;
      filter.type = 'bandpass';
      filter.frequency.value = sound === 'brush' ? 1400 : 2300;
      filter.Q.value = 0.7;
      source.connect(filter).connect(gain);
      source.start(now);
      voice.sources.push(source);
    } else if (sound === 'glass') {
      duration = 0.65; oscillator(780, 'sine'); oscillator(1563, 'sine', 0.2);
    } else if (sound === 'bell') {
      duration = 0.9; oscillator(523.25, 'sine'); oscillator(1046.5, 'sine', 0.24); oscillator(1569.75, 'sine', 0.08);
    } else if (sound === 'low') {
      duration = 0.38; oscillator(145, 'sine', 1, 75); oscillator(218, 'sine', 0.1);
    } else {
      duration = 0.16; oscillator(440, 'sine', 0.75, 180); oscillator(790, 'sine', 0.13, 490);
    }
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + Math.min(0.009, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    const last = voice.sources[voice.sources.length - 1];
    if (last) last.addEventListener('ended', () => { this.voices.delete(voice); gain.disconnect(); }, { once: true });
    return true;
  }
}
