# Карта задержек Москвы

MapLibre GL JS 6.11.2 (BSD-3-Clause) рендерит локальные vector tiles, панорамирование и масштаб. Three.js 0.180.0 рисует только GPS-точки автобусов в MapLibre custom 3D layer (общая матрица и WebGL context; MercatorCoordinate масштабируется в world pixels на текущем zoom). Браузер читает только consumer `/api/snapshot`; не строит маршруты, не вычисляет прогноз и не выдаёт цвет за вероятность. Серый — неизвестно, degraded или offline; зелёный <2 мин, янтарный ≥2, красный ≥5 мин **только** для normal prediction.

## Запуск

Из корня репозитория: `SOURCE_CLOCK=simulation docker compose --profile simulation up --build -d ml backend consumer emulator`; после healthy: `python scripts/start_ndtp_simulation.py`; открыть `http://localhost:8002`. Команда поднимет сервис и эмулятор, но не доказывает 15 минут новых прогнозов: см. W2 в task.md. Для локальной пересборки UI после изменения `dashboard/app.js` или CSS: `npm ci --prefix dashboard && npm --prefix dashboard run build`, затем `docker compose build consumer` и пересоздать **только** consumer. Bundles находятся в `consumer/static/`, карта — `consumer/map/moscow.pmtiles`. Нельзя запускать эмуляторный reset параллельно с чужим прогоном.

## Происхождение геоосновы

Локальный PMTiles v3, MVT (слои `water`, `roads` и другие), bbox 37.25,55.50,38.00,56.00, zoom 0–13. Из Protomaps basemap `https://build.protomaps.com/20260925.pmtiles`, OSM replication time **2026-09-25T04:00:00Z**, источник OSM/ODbL (© OpenStreetMap contributors); metadata и sha256 находятся в `consumer/map/manifest.json`. Это **геометрия OSM дорог**, а не маршрут автобуса. Воспроизводимая команда с go-pmtiles v1.31.2:

```sh
pmtiles extract https://build.protomaps.com/20260925.pmtiles consumer/map/moscow.pmtiles --bbox=37.25,55.50,38.00,56.00 --minzoom=0 --maxzoom=13
shasum -a 256 consumer/map/moscow.pmtiles
```

Полный архив большой; для **offline browser** он не нужен: все JS, CSS, worker и плитки поставляются consumer по localhost. Прямых запросов к публичным raster tile endpoint нет. Охват извлечения ограничен bbox, не вся Московская область. За пределами bbox карты нет; при отсутствии архива интерфейс явно сообщает об ошибке. Контрольные координаты: центр [37.6173,55.7558], юго-восточная остановка [37.69396762,55.68474819] — внутри bbox. API `/map/moscow.pmtiles` поддерживает HTTP Range.

## Проверки

`npm --prefix dashboard run build`, `.venv/bin/python -m pytest -q tests/test_consumer.py`. Для browser smoke: поднять consumer на `http://127.0.0.1:18882` (например `BACKEND_URL=http://127.0.0.1:8001 .venv/bin/uvicorn consumer.service:app --port 18882`), затем `UI_SCREENSHOT=/absolute/path.png node dashboard/browser-check.mjs`. Он подменяет **только** `/api/snapshot` для управляемых normal → unavailable → offline состояний; реальные PMTiles и JS идут с сервера, внешние запросы и JS errors запрещены; проверяются revision, карточка, zoom и pan. Этот smoke не доказывает живой NDTP. Отдельно открыть без подмены и проверить фактический revision и позиции. Артефакты текущей проверки: `.tasks/T-6-2026-09-26-ndtp/artifacts/workflow/map-browser.png` (управляемый сценарий), `map-live.png` (существующий backend snapshot, не W2). Остановка/восстановление источника в UI видны через последний снимок consumer, а не новые предсказания.
