# UltraSquad

Локальный сервер автономных ИИ-агентов с прямой трансляцией.

- До 100 агентов ходят по реальному интернету (поиск + чтение страниц), эфир и граф сети в реальном времени
- Только бесплатные модели OpenRouter (`:free`); платные заблокированы в коде
- Ловушки и сигнатуры атак, агент Sentinel банит атакующих
- Без внешних зависимостей, только Node.js 18+

## Запуск
1. `copy .env.example .env` и впиши ключ OpenRouter
2. `node server.js` → http://127.0.0.1:7777
3. Автозапуск с Windows: `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`

## Защита на Windows

Запуск: `node server.js`. Панель защиты: http://127.0.0.1:7777/#security.
Sentinel обновляет состояние Microsoft Defender каждые 30 секунд и сообщает в чат об изменениях.
«Быстрая проверка» запускает штатное сканирование Windows, если права пользователя позволяют.
Историю обнаружений и действия с угрозами можно посмотреть в «Безопасности Windows».
Патруль и блокировка подозрительных входящих запросов работают без ключей и модели.

Vercel публикует интерфейс из `public`. Панель с данными, камера и агент Windows работают через локальный сервер.

## Сервер на Android

Установи [Termux](https://github.com/termux/termux-app#installation), затем выполни:

```sh
pkg update
pkg install git nodejs-lts
git clone https://github.com/GX85/UltraSquad-.git ultrasquad
cd ultrasquad
node server.js
```

Открой http://127.0.0.1:7777/#live в браузере на этом же телефоне.
Для работы сервера оставь Termux запущенным. На Android доступны чат, цели и журнал запросов этого сервера.
Microsoft Defender и камера Edge работают только в Windows.

## Вход на публичном сайте

UltraSquad подключается напрямую к Google и GitHub через OAuth.
Зарегистрируй веб-клиент Google и OAuth App на GitHub. Укажи соответствующий адрес возврата:

- Google: `https://ultrasquad.vercel.app/api/auth?action=callback&provider=google`
- GitHub: `https://ultrasquad.vercel.app/api/auth?action=callback&provider=github`

Добавь в настройки Production на Vercel `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` и отдельный случайный `AUTH_SESSION_SECRET`
размером не менее 32 байт. После изменения переменных переопубликуй сайт.
Можно начать с одного провайдера: сайт покажет только настроенные кнопки.
Секреты остаются в Vercel. Вход на Vercel не открывает управление локальным сервером из интернета.
