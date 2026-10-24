// Короткие звуковые сигналы: проверка устройства вывода и подтверждение горячих клавиш
// (окно свёрнуто, в игре не видно, выключился микрофон или включился).

/**
 * @param {string} deviceId устройство вывода ('default' — системное)
 * @param {Array<[number, number, number]>} notes [частота Гц, начало с, длительность с]
 */
export async function playTones(deviceId, notes, volume = 0.25) {
  const ctx = new AudioContext();
  try {
    if (deviceId && deviceId !== 'default') await ctx.setSinkId(deviceId);
    const t = ctx.currentTime + 0.05;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, t);
    let end = t;
    for (const [freq, start, duration] of notes) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t + start);
      osc.stop(t + start + duration);
      gain.gain.setTargetAtTime(volume, t + start, 0.01);
      gain.gain.setTargetAtTime(0, t + start + duration - 0.05, 0.015);
      end = Math.max(end, t + start + duration);
    }
    await new Promise((resolve) => setTimeout(resolve, (end - ctx.currentTime + 0.1) * 1000));
  } finally {
    await ctx.close();
  }
}

/** Проверка устройства вывода: два тона вверх */
export const playTestTone = (deviceId) =>
  playTones(deviceId, [
    [660, 0, 0.25],
    [880, 0.3, 0.25],
  ]);

const CUES = {
  on: [
    [520, 0, 0.09],
    [780, 0.1, 0.12],
  ],
  off: [
    [780, 0, 0.09],
    [520, 0.1, 0.12],
  ],
  deafen: [
    [440, 0, 0.09],
    [330, 0.1, 0.09],
    [262, 0.2, 0.12],
  ],
  undeafen: [
    [262, 0, 0.09],
    [330, 0.1, 0.09],
    [440, 0.2, 0.12],
  ],
};

/** Сигнал переключения: 'on' | 'off' | 'deafen' | 'undeafen' */
export function playCue(kind, deviceId) {
  return playTones(deviceId, CUES[kind], 0.15).catch(() => {});
}
