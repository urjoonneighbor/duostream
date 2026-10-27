// Звуковая дорожка из звука приложения транслируемого окна (src/main/app-audio.js → сюда порциями PCM).
// AudioWorklet с кольцевым буфером → MediaStreamDestination → обычный стерео-трек для WebRTC.

export class AppAudioTrack {
  constructor() {
    this.session = null;
    this.stopped = false;
  }

  /** @returns {Promise<MediaStreamTrack>} */
  async start(sourceId) {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('../audio/pcm-player-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'duo-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.node.connect(dest);
    window.duo.appAudio.onData((session, samples) => {
      if (session === this.session && !this.stopped) this.node.port.postMessage(samples, [samples.buffer]);
    });
    const result = await window.duo.appAudio.start(sourceId);
    if (!result.ok) {
      this.stop();
      throw new Error(result.error);
    }
    this.session = result.session;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.track = dest.stream.getAudioTracks()[0];
    return this.track;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.session !== null) window.duo.appAudio.stop(this.session);
    this.track?.stop();
    this.ctx?.close();
  }
}
