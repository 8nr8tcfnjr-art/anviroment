# ОКРУЖЕНИЕ — Render Server

Этот сервис выносит MP4-кодирование из Safari/iPhone. Браузер рендерит visual canvas + audio в WebM, отправляет готовый WebM сюда, а серверный FFmpeg делает настоящий MP4 (H.264 + AAC).

## Быстрый запуск

Требуется Node.js 20+.

```bash
npm install
npm start
```

Проверка:

```text
GET http://localhost:8787/health
```

## Подключение фронтенда

Перед загрузкой `index.html` установите:

```html
<script>
  window.OKRUZ_RENDER_API = 'https://YOUR-RENDER-SERVER.example.com';
</script>
```

Либо в DevTools:

```js
localStorage.setItem('okruzhenie_render_api', 'https://YOUR-RENDER-SERVER.example.com')
```

## Docker

```bash
docker build -t okruzhenie-render .
docker run --rm -p 8787:8787 -e ALLOW_ORIGIN=https://YOUR-FRONTEND.vercel.app okruzhenie-render
```

Для production лучше использовать отдельный постоянно работающий VPS/container host. Не размещайте этот worker в короткоживущей serverless-функции: 4K/60 и длинные ambient renders требуют CPU-времени.

## Что происходит

1. iPhone/браузер собирает canvas + внутренний audio stream.
2. Получается WebM только как транспортный промежуточный файл.
3. WebM загружается на render server.
4. FFmpeg кодирует H.264 + AAC, 48 kHz stereo.
5. Клиент получает статус job и скачивает готовый MP4.

Это не «переименование WebM в MP4».
