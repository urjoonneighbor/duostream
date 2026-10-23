# Резервный TURN-сервер (необязательно)

При белом IP и проброшенных портах у стримера TURN не нужен: зритель подключается напрямую.
TURN пригодится, если **сеть зрителя не пропускает UDP** на произвольные порты (офис, гостиница,
некоторые публичные Wi-Fi): тогда зритель подключается к TURN по TCP, а TURN пересылает медиа
стримеру. Трафик при этом идёт через ПК стримера, сторонних серверов по-прежнему нет.

Ниже — coturn в WSL2 на ПК стримера (Windows 11 22H2 и новее).

## 1. WSL2 с «зеркальной» сетью

Чтобы coturn видел реальные сетевые интерфейсы Windows, включите режим mirrored. Создайте или
дополните файл `%UserProfile%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

PowerShell от имени администратора — установка Ubuntu (если ещё нет), перезапуск WSL и разрешение
входящих подключений в WSL:

```powershell
wsl --install -d Ubuntu
```

```powershell
wsl --shutdown
```

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

## 2. Установка и настройка coturn (в Ubuntu)

```bash
sudo apt update && sudo apt install -y coturn
```

Создайте `/etc/turnserver.conf` (например, `sudo nano /etc/turnserver.conf`), подставьте свой белый
IP, локальный IP ПК и пароль:

```ini
listening-port=3478
external-ip=203.0.113.10/192.168.1.50
# Порты релея — не пересекаются с диапазоном WebRTC 50000–50019
min-port=50100
max-port=50199
realm=duostream
lt-cred-mech
user=duo:ДЛИННЫЙ-ПАРОЛЬ-TURN
fingerprint
no-tls
no-dtls
no-cli
no-multicast-peers
```

Запуск (окно держите открытым, как и сигнальный сервер):

```bash
sudo turnserver -c /etc/turnserver.conf
```

## 3. Порты

Пробросьте на роутере на ПК стримера и разрешите в брандмауэре Windows
([как — см. 02-port-forwarding.md](02-port-forwarding.md)):

| Порт | Протокол |
|---|---|
| 3478 | UDP и TCP |
| 50100–50199 | UDP |

## 4. Настройка приложения (у обоих)

«Настройки» → «Сеть» → «Резервный TURN-сервер»: включить, адрес `turn:203.0.113.10:3478`,
логин `duo`, пароль из конфига. Чтобы зритель за закрытым UDP подключался к TURN по TCP, в
`stream.config.json` можно добавить в `network.iceServers` ещё одну запись:

```json
{ "urls": ["turn:203.0.113.10:3478?transport=tcp"], "username": "duo", "credential": "ДЛИННЫЙ-ПАРОЛЬ-TURN" }
```

Проверка: включите у зрителя «Только через TURN», подключитесь — в статистике строка «Путь» покажет
`через TURN-релей`. После проверки галочку снимите: в обычном режиме TURN используется, только
если прямой путь не установился.
