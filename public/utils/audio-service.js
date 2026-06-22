export function createAudioService(options = {}) {
  let audioCtx = null;
  let playbackGain = null;
  let playbackTime = 0;
  let audioNodes = [];
  let audioGeneration = 0;
  let playbackTimers = [];
  let micStream = null;
  let source = null;
  let processor = null;
  let aiAnalyser = null;
  let micAnalyser = null;
  let aiFreqData = null;
  let micFreqData = null;

  const getVoiceEnabled = () => options.getVoiceEnabled?.() ?? true;
  const shouldSendAudio = () => options.shouldSendAudio?.() ?? false;
  // May be called before the websocket/session is ready; callers decide whether
  // to buffer or send the realtime input.
  const onAudioInput = (payload) => options.onAudioInput?.(payload);
  const onCaptionDue = (payload) => options.onCaptionDue?.(payload);
  const onMicEnded = () => options.onMicEnded?.();

  function clearPlaybackTimers() {
    playbackTimers.forEach((timer) => clearTimeout(timer));
    playbackTimers = [];
  }

  function stopAiAudioPlayback() {
    audioGeneration += 1;
    clearPlaybackTimers();
    audioNodes.forEach((node) => { try { node.stop(); } catch {} });
    audioNodes = [];
    playbackTime = 0;
  }

  function syncPlaybackVolume() {
    if (!playbackGain || !audioCtx) return;
    const value = getVoiceEnabled() ? 1 : 0;
    playbackGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.015);
  }

  async function ensureAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      const error = new Error('当前浏览器不支持音频功能');
      error.name = 'NotSupportedError';
      throw error;
    }
    audioCtx ||= new AudioContextClass();
    if (!playbackGain) {
      playbackGain = audioCtx.createGain();
      playbackGain.connect(audioCtx.destination);
    }
    if (!aiAnalyser) {
      aiAnalyser = audioCtx.createAnalyser();
      aiAnalyser.fftSize = 64;
      aiAnalyser.smoothingTimeConstant = 0.7;
      aiFreqData = new Uint8Array(aiAnalyser.frequencyBinCount);
      playbackGain.connect(aiAnalyser);
    }
    if (audioCtx.state !== 'running') await audioCtx.resume();
    syncPlaybackVolume();
    playbackTime = Math.max(playbackTime, audioCtx.currentTime);
  }

  async function playReadyTone(toneOptions = {}) {
    const { type = 'sine', queued = false } = toneOptions;
    await ensureAudio();
    const startTime = queued ? Math.max(playbackTime, audioCtx.currentTime) + 0.08 : audioCtx.currentTime;
    const duration = 0.16;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(660, startTime);
    osc.frequency.exponentialRampToValueAtTime(880, startTime + duration);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(playbackGain);
    osc.onended = () => {
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
    if (queued) playbackTime = startTime + duration + 0.02;
  }

  async function playPcm(data, mime = 'audio/pcm;rate=24000', caption = '', messageId = '') {
    const generation = audioGeneration;
    await ensureAudio();
    if (generation !== audioGeneration) return;
    const rate = +(mime.match(/rate=(\d+)/)?.[1] || 24000);
    const raw = atob(data);
    const samples = raw.length / 2;
    const buffer = audioCtx.createBuffer(1, samples, rate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < samples; i += 1) {
      const lo = raw.charCodeAt(i * 2);
      const hi = raw.charCodeAt(i * 2 + 1);
      let value = (hi << 8) | lo;
      if (value & 0x8000) value -= 0x10000;
      out[i] = value / 32768;
    }
    const node = audioCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(playbackGain);
    playbackTime = Math.max(playbackTime, audioCtx.currentTime);
    const startTime = playbackTime;
    if (caption) scheduleCaptionAt(caption, startTime, generation, messageId);
    node.onended = () => { audioNodes = audioNodes.filter((item) => item !== node); };
    audioNodes.push(node);
    node.start(playbackTime);
    playbackTime += buffer.duration;
  }

  function scheduleCaptionAt(text, audioTime, generation = audioGeneration, messageId = '') {
    const currentTime = audioCtx?.currentTime || 0;
    const delay = Math.max(0, ((audioTime || currentTime) - currentTime) * 1000);
    const timer = setTimeout(() => {
      if (generation === audioGeneration) onCaptionDue({ text, messageId });
    }, delay);
    playbackTimers.push(timer);
  }

  async function checkMicAvailable() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      const error = new Error('当前页面非安全上下文，无法使用麦克风');
      error.name = 'InsecureContextError';
      throw error;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      const error = new Error('当前浏览器不支持麦克风');
      error.name = 'NotSupportedError';
      throw error;
    }
    if (navigator.permissions?.query) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        if (status.state === 'denied') {
          const error = new Error('麦克风权限被拒绝');
          error.name = 'NotAllowedError';
          throw error;
        }
      } catch (err) {
        if (err?.name === 'NotAllowedError') throw err;
      }
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.length && !devices.some((device) => device.kind === 'audioinput')) {
        const error = new Error('未检测到麦克风');
        error.name = 'NotFoundError';
        throw error;
      }
    } catch (err) {
      if (err?.name === 'NotFoundError') throw err;
    }
    return true;
  }

  async function startMic() {
    if (micStream || processor) return true;
    await ensureAudio();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 64;
    micAnalyser.smoothingTimeConstant = 0.7;
    micFreqData = new Uint8Array(micAnalyser.frequencyBinCount);
    source.connect(micAnalyser);
    const track = micStream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', onMicEnded);
    processor.onaudioprocess = function processMicAudio(event) {
      if (!shouldSendAudio()) return;
      const input = event.inputBuffer.getChannelData(0);
      const ratio = audioCtx.sampleRate / 16000;
      const pcm = new Int16Array(Math.floor(input.length / ratio));
      for (let i = 0; i < pcm.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      onAudioInput({
        data: b64(new Uint8Array(pcm.buffer)),
        mimeType: 'audio/pcm;rate=16000',
      });
    };
    return true;
  }

  function stopMic() {
    processor?.disconnect();
    source?.disconnect();
    try { micAnalyser?.disconnect(); } catch {}
    micStream?.getTracks().forEach((track) => track.stop());
    processor = source = micStream = micAnalyser = micFreqData = null;
  }

  async function destroy() {
    stopMic();
    stopAiAudioPlayback();
    try { aiAnalyser?.disconnect(); } catch {}
    aiAnalyser = aiFreqData = null;
    if (audioCtx) {
      await audioCtx.close();
      audioCtx = null;
    }
    playbackGain = null;
    playbackTime = 0;
  }

  function sampleWaveform(analyser, buffer, bins) {
    const result = new Array(bins).fill(0);
    if (!analyser || !buffer || bins <= 0) return result;
    analyser.getByteFrequencyData(buffer);
    const usable = Math.max(1, Math.floor(buffer.length * 0.75));
    const slice = Math.max(1, Math.floor(usable / bins));
    const bands = new Array(bins);
    for (let b = 0; b < bins; b += 1) {
      const start = b * slice;
      const end = Math.min(usable, start + slice);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += buffer[j];
      bands[b] = end > start ? sum / ((end - start) * 255) : 0;
    }
    const center = (bins - 1) / 2;
    const order = Array.from({ length: bins }, (_, i) => i)
      .sort((a, b) => {
        const da = Math.abs(a - center);
        const db = Math.abs(b - center);
        return da !== db ? da - db : a - b;
      });
    for (let i = 0; i < bins; i += 1) {
      result[order[i]] = Math.min(1, bands[i] * 0.9);
    }
    return result;
  }

  function getAiWaveform(bins = 5) {
    return sampleWaveform(aiAnalyser, aiFreqData, bins);
  }

  function getUserWaveform(bins = 5) {
    return sampleWaveform(micAnalyser, micFreqData, bins);
  }

  function b64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  return {
    ensureAudio,
    playReadyTone,
    playPcm,
    stopAiAudioPlayback,
    syncPlaybackVolume,
    checkMicAvailable,
    startMic,
    stopMic,
    destroy,
    hasQueuedPlayback: () => audioNodes.length > 0,
    getAiWaveform,
    getUserWaveform,
  };
}
