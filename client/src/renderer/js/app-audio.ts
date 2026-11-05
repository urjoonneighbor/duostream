// Звуковая дорожка из звука приложения транслируемого окна (src/main/app-audio.ts → сюда порциями PCM).
// AudioWorklet с кольцевым буфером → MediaStreamDestination → обычный стерео-трек для WebRTC.

/** Счётчики проигрывателя за всё время трансляции (pcm-player-worklet.ts) */
export interface AppAudioStats {
  underruns: number; // сколько раз звук кончался раньше, чем пришла новая порция (дыра — треск)
  trimmedMs: number; // сколько пришлось выбросить из-за завала
  bufferedMs: number; // запас сейчас
}

export class AppAudioTrack {
  session: number | null = null;
  stopped = false;
  track: MediaStreamTrack | null = null;
  stats: AppAudioStats | null = null;
  private ctx: AudioContext | null = null;

  async start(sourceId: string): Promise<MediaStreamTrack> {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' }); // запас буферов — см. SendGain
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('../audio/pcm-player-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'duo-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    node.port.onmessage = (event: MessageEvent<AppAudioStats>) => (this.stats = event.data);
    window.duo.appAudio.onData((session, samples) => {
      if (session === this.session && !this.stopped) node.port.postMessage(samples, [samples.buffer]);
    });
    const result = await window.duo.appAudio.start(sourceId);
    if (!result.ok) {
      this.stop();
      throw new Error(result.error);
    }
    this.session = result.session;
    if (ctx.state === 'suspended') await ctx.resume();
    this.track = dest.stream.getAudioTracks()[0];
    return this.track;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.session !== null) void window.duo.appAudio.stop(this.session);
    this.track?.stop();
    void this.ctx?.close();
  }
}
