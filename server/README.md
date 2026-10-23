# Сигнальный сервер DuoStream

Минимальный WebSocket-сервер на Node.js. Сводит стримера и зрителя и пересылает между ними SDP
и ICE-кандидаты. Медиа через него не идёт, ничего не хранится. Запускается на ПК стримера.

```powershell
npm install
npm test
npm start
```

Перед первым запуском задайте `password` в `config.json` (от 8 символов) или переменную
`DUO_PASSWORD`. Порт по умолчанию — TCP 8787, его нужно пробросить на роутере
([../docs/02-port-forwarding.md](../docs/02-port-forwarding.md)). Проверка снаружи:
`http://<белый IP>:8787/` отвечает `DuoStream signaling server: OK`.

## Протокол

JSON поверх WebSocket, ровно две роли — `streamer` и `viewer`:

1. Сервер → `{type:"challenge", nonce, version}`.
2. Клиент → `{type:"hello", role, name, proof, version}`, где
   `proof = HMAC-SHA256(PBKDF2-SHA256(password, "duostream/v1", 200000), "auth:" + nonce + ":" + role)`.
   Пароль по сети не передаётся.
3. Сервер → `{type:"welcome", role, peer}`; второму участнику — `{type:"peer-joined", peer}`.
4. `{type:"signal", payload, ts, sig}` пересылается собеседнику без изменений. Подпись `sig` ставит и
   проверяет сам клиент, поэтому сервер или посредник не может подменить SDP.
5. При отключении собеседнику уходит `{type:"peer-left", role}`. Повторный вход с той же ролью
   вытесняет старое соединение (код закрытия 4004).

Коды закрытия: 4001 — нет hello за 10 с, 4002 — неверный пароль, 4003 — IP заблокирован после
5 ошибок, 4005 — другая версия протокола, 4008 — слишком много сообщений.
