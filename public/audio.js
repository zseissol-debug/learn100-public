const rate = 16000;
const frameSize = 320;

function encode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export class AudioBridge {
  constructor(send) { this.send = send; this.playAt = 0; this.sources = new Set(); this.pending = []; this.heardSeconds = 0; this.nextInputSample = 0; }

  async start() {
    this.context = new AudioContext();
    await this.context.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.silent = this.context.createGain(); this.silent.gain.value = 0;
    this.source.connect(this.processor); this.processor.connect(this.silent); this.silent.connect(this.context.destination);
    this.capture = false;
    this.processor.onaudioprocess = event => { if (this.capture) this.feed(event.inputBuffer.getChannelData(0), this.context.sampleRate); };
    this.uplinkTimer = setInterval(() => { if (this.capture) this.sendFrame(); }, 20);
  }

  feed(input, sourceRate) {
    const ratio = sourceRate / rate;
    for (let i = this.nextInputSample; i < input.length; i += ratio) {
      const value = Math.max(-1, Math.min(1, input[Math.floor(i)]));
      this.pending.push(value < 0 ? value * 0x8000 : value * 0x7fff);
    }
    this.nextInputSample = (this.nextInputSample + Math.ceil((input.length - this.nextInputSample) / ratio) * ratio) - input.length;
  }

  sendFrame(pad = false) {
    if (this.pending.length < frameSize && !pad) return;
    const bytes = new Uint8Array(frameSize * 2); const view = new DataView(bytes.buffer);
    for (let index = 0; index < frameSize; index++) view.setInt16(index * 2, this.pending[index] || 0, true);
    this.pending.splice(0, frameSize);
    this.send({ type: 'input_audio_buffer.append', audio: encode(bytes) }); this.heardSeconds += 0.02;
  }

  begin() { this.pending = []; this.heardSeconds = 0; this.nextInputSample = 0; this.capture = true; this.send({ type: 'input_audio_unmute.commit' }); }
  finish() {
    this.capture = false;
    while (this.pending.length) this.sendFrame(true);
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'input_audio_mute.commit' });
    return this.heardSeconds;
  }

  play(base64) {
    if (!this.context || !base64) return;
    const binary = atob(base64); const length = Math.floor(binary.length / 2);
    const buffer = this.context.createBuffer(1, length, 24000), channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      channel[i] = (value > 32767 ? value - 65536 : value) / 32768;
    }
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    source.onended = () => this.sources.delete(source);
    source.start(Math.max(this.context.currentTime + 0.01, this.playAt));
    this.playAt = Math.max(this.context.currentTime + 0.01, this.playAt) + buffer.duration;
    this.sources.add(source);
  }

  async drained() {
    while (this.context && this.playAt - this.context.currentTime > 0.05) await new Promise(resolve => setTimeout(resolve, 80));
  }

  interrupt() { for (const source of this.sources) { try { source.stop(); } catch {} } this.sources.clear(); this.playAt = this.context?.currentTime || 0; }
  async stop() {
    this.capture = false; clearInterval(this.uplinkTimer); this.interrupt(); this.processor?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop()); await this.context?.close(); this.context = null;
  }
}
