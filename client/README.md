# Приложение DuoStream (Electron)

```powershell
npm install          # Electron, ONNX Runtime в src/renderer/vendor/ort, сборка захвата (если есть .NET SDK 10)
npm start            # запуск
npm run start:viewer # второй экземпляр с отдельным профилем (проверка на одном ПК)
npm run build:native # собрать native/bin/duostream-capture.exe (захват 120 FPS)
npm run test:denoiser
npm run dist         # DuoStream-Setup / portable exe в dist/ (захват, сервер — всё внутри)
```

Полная инструкция — [../docs/01-install.md](../docs/01-install.md), параметры —
[../docs/05-config.md](../docs/05-config.md).

## Как устроено

- **src/main/main.js** — флаги Chromium (`WebRtcAV1HWEncode`, без mDNS), фиксированный диапазон
  UDP-портов WebRTC, протокол `app://local` (нужен для module worker и WASM), выбор источника
  захвата для `getDisplayMedia` и системный звук (loopback), разрешения.
- **native/capture/** (C#, .NET 10) — собственный захват: Windows Graphics Capture с
  `MinUpdateInterval = 1 мс` (встроенный в Chromium захват на Windows 11 24H2+ ограничен ~60 FPS),
  кольцо общих D3D11-текстур с NT-хэндлами, продублированными в процесс Electron, выбор той же
  видеокарты, что у Chromium, ресайз окон без пересоздания текстур (`visibleRect`).
- **src/main/native-capture.js** — запускает процесс захвата, импортирует текстуры через
  `sharedTexture`, отправляет их в окно и возвращает процессу освобождённые; ошибки и закрытие
  источника уходят в интерфейс событиями.
- **src/renderer/js/native-capture.js** — `VideoFrame` из текстуры → `MediaStreamTrackGenerator`;
  **app.js** при любом сбое собственного захвата (не собран, не стартовал, упал, нет кадров 3 с)
  переключается на `getDisplayMedia`.
- **src/renderer/js/peer.js** — WebRTC: три m-секции (голос sendrecv, видео и системный звук
  sendonly), `replaceTrack` без пересогласования, кандидаты «белый IP : проброшенный порт»,
  ICE restart, пересоздание сессии, если энкодер ушёл с NVENC на CPU.
- **src/renderer/js/codecs.js** — `MediaCapabilities.encodingInfo` (аппаратный ли энкодер),
  `setCodecPreferences`, определение HW/SW по статистике.
- **src/renderer/js/sdp.js** — `x-google-min/start/max-bitrate`, `b=AS`, параметры Opus (FEC, стерео).
- **src/renderer/audio/** — шумодав: AudioWorklet режет звук на кадры по 8 мс и через MessagePort
  отдаёт их Web Worker; там ONNX Runtime Web (WASM) прогоняет DTLN (48 → 16 кГц → модель → 48 кГц).
  `dtln-core.js` не зависит от браузера и проверяется в Node (`scripts/test-denoiser.mjs`).
- **src/renderer/js/stats.js** — битрейт, пинг, потери, FPS, кодек, путь P2P/TURN.

Отладка: F12 открывает DevTools, в консоли доступен `duoDebug` — состояние приложения
(например, `duoDebug.session.pc.getStats()`, `duoDebug.capture` — способ и размер захвата,
`duoDebug.capture.native.lastFrameInfo` — размер текстуры и кадра собственного захвата).
