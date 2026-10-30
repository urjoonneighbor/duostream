# Приложение DuoStream (Electron)

```powershell
npm install          # Electron, ONNX Runtime в src/renderer/vendor/ort, сборка захвата (если есть .NET SDK 10)
npm start            # сборка TypeScript (npm run build → app/) и запуск
npm run typecheck    # проверка типов всех частей без сборки
npm run start:viewer # второй экземпляр с отдельным профилем (проверка на одном ПК)
npm run build:native # собрать native/bin/duostream-capture.exe (захват 120 FPS)
npm run test:denoiser
npm run dist         # DuoStream-Setup / portable exe в dist/ (захват, сервер — всё внутри); ничего не публикует
npm run fetch-models # перекачать ONNX-модели шумодава (DeepFilterNet3, DTLN) с проверкой SHA-256
# Electron не скачался («Electron failed to install correctly»):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-electron.ps1
```

Полная инструкция — [../docs/01-install.md](../docs/01-install.md), параметры —
[../docs/05-config.md](../docs/05-config.md).

## Как устроено

- **TypeScript без сборщика.** `tsc` собирает `src/**/*.ts` в `app/` по отдельному tsconfig на каждую
  среду: `tsconfig.main.json` (главный процесс и preload, CommonJS), `tsconfig.renderer.json` (интерфейс,
  ES-модули), `tsconfig.worker.json` (Web Worker шумодава), `tsconfig.worklet.json` (AudioWorklet),
  `tsconfig.scripts.json` (только проверка `scripts/*.mts` — их Node запускает напрямую). Импорты пишутся
  с `.ts`, в `app/` они становятся `.js`. Протокол `app://local` отдаёт `.js` из `app/renderer`, остальное
  (HTML, стили, модели, ONNX Runtime) — из `src/renderer`. Общие типы — `src/shared/*.d.ts`.
- **src/main/main.ts** — флаги Chromium (`WebRtcAV1HWEncode`, без mDNS), фиксированный диапазон
  UDP-портов WebRTC, протокол `app://local` (нужен для module worker и WASM), выбор источника
  захвата для `getDisplayMedia` и системный звук (loopback), разрешения.
- **native/capture/** (C#, .NET 10) — собственный захват: Windows Graphics Capture с
  `MinUpdateInterval = 1 мс` (встроенный в Chromium захват на Windows 11 24H2+ ограничен ~60 FPS),
  кольцо общих D3D11-текстур с NT-хэндлами, продублированными в процесс Electron, выбор той же
  видеокарты, что у Chromium, ресайз окон без пересоздания текстур (`visibleRect`).
- **src/main/native-capture.ts** — запускает процесс захвата, импортирует текстуры через
  `sharedTexture`, отправляет их в окно и возвращает процессу освобождённые; ошибки и закрытие
  источника уходят в интерфейс событиями.
- **src/renderer/js/native-capture.ts** — `VideoFrame` из текстуры → `MediaStreamTrackGenerator`;
  **app.ts** при любом сбое собственного захвата (не собран, не стартовал, упал, нет кадров 3 с)
  переключается на `getDisplayMedia`.
- **src/renderer/js/peer.ts** — WebRTC: три m-секции (голос sendrecv, видео и системный звук
  sendonly), `replaceTrack` без пересогласования, кандидаты «белый IP : проброшенный порт»,
  ICE restart, пересоздание сессии, если энкодер ушёл с NVENC на CPU.
- **src/renderer/js/codecs.ts** — `MediaCapabilities.encodingInfo` (аппаратный ли энкодер),
  `setCodecPreferences`, определение HW/SW по статистике.
- **src/renderer/js/sdp.ts** — `x-google-min/start/max-bitrate`, `b=AS`, параметры Opus (FEC, стерео).
- **src/renderer/audio/** — шумодав: AudioWorklet режет звук на кадры модели и через MessagePort
  отдаёт их Web Worker; там ONNX Runtime Web (WASM) прогоняет DeepFilterNet3 (`dfn-core.ts`: кадр 10 мс
  на 48 кГц, полный диапазон, рекуррентное состояние между кадрами, голосовой порог по оценке SNR модели)
  или лёгкую DTLN (`dtln-core.ts`: 48 → 16 кГц → модель → 48 кГц). Модель меняется на лету; если
  DeepFilterNet3 не загрузится, воркер сам включит DTLN. Оба ядра не зависят от браузера и проверяются
  в Node (`scripts/test-denoiser.mts`).
- **src/main/hotkeys.ts** — глобальные горячие клавиши на низкоуровневом хуке (uiohook-napi, готовая
  сборка N-API — компилятор не нужен): нажатие и отпускание клавиш и кнопок мыши, назначение «нажмите
  клавишу». Действия выполняет интерфейс (`app.ts` → `onHotkey`) и подтверждает звуком (`js/tones.ts`).
- **src/main/updater.ts** — electron-updater: релизы GitHub, которые публикует
  `.github/workflows/release.yml`.
- **src/renderer/img/icon.svg** — иконка приложения. `build/icon.ico` (exe, установщик, ярлыки) и
  `src/renderer/img/icon-256.png` (окно) делаются из неё: `npx electron scripts/make-icons.mts`.
- **src/renderer/js/stats.ts** — битрейт, пинг, потери, FPS, кодек, путь P2P/TURN.

Отладка: F12 открывает DevTools, в консоли доступен `duoDebug` — состояние приложения
(например, `duoDebug.session.pc.getStats()`, `duoDebug.capture` — способ и размер захвата,
`duoDebug.capture.native.lastFrameInfo` — размер текстуры и кадра собственного захвата).
