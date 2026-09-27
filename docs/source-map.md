---
title: Карта происхождения файлов transport2
type: note
status: active
owner: transport2
tags: [provenance, repository]
updated: "2026-09-27T16:46:23Z"
source_commit: "50e3b1cde8db"
update_event: "user_request"
context: "changes=L files=20"
description: "Карта механического переноса, исключений и происхождения файлов."
---

# Карта происхождения файлов

Дата механического переноса: 2026-09-25.

## Официальная раздача

Источник: `~/Downloads/dataset`.

| Исходный путь | Целевой путь | Решение |
|---|---|---|
| `README.md` | `data/README.md` | Скопирован без изменений |
| `train/` | `data/train/` | Скопирован без изменений, исключён из Git |
| `test/` | `data/test/` | Скопирован без изменений, исключён из Git |
| `validate/` | `data/validate/` | Скопирован без изменений; `traffic.csv` и `schedule_plan.csv` включены в Git для запуска демо, остальные файлы исключены |
| `labels/` | `data/labels/` | Скопирован без изменений, исключён из Git |
| `sample_submission.csv` | `data/sample_submission.csv` | Скопирован без изменений |
| `docs/Emulator-and-Telematic-Packets-Specification.md` | `data/docs/Emulator-and-Telematic-Packets-Specification.md` | Скопирован без изменений; каноническая спецификация |
| `ndtp-telemetry-emulator.tar` | `data/emulator/ndtp-telemetry-emulator.tar` | Скопирован без изменений, исключён из Git |
| `.DS_Store` | — | Исключён как системный мусор |

## Начальное ML-решение

Источник: `~/Downloads/transport_ml_solution`.

| Исходный путь | Целевой путь | Решение |
|---|---|---|
| `transport_ml/` | `transport_ml/` | Скопирован без изменений |
| `tests/` | `tests/` | Скопирован без изменений |
| `artifacts/` | `artifacts/` | Скопирован без `.DS_Store`; артефакты относятся к малой выборке |
| `Dockerfile`, `compose.yaml`, `.dockerignore` | те же пути в корне | Скопированы без изменений |
| `requirements.txt`, `requirements-torch.txt` | те же пути в корне | Скопированы без изменений |
| `example_request.json` | `example_request.json` | Скопирован без изменений |
| `docs/openapi.json` | `docs/api/openapi.json` | Скопирован без изменения содержимого |
| `docs/pydoc/` | `docs/pydoc/` | Скопирован без изменений; в T-8 заменён PyDoc текущих 12 модулей (`docs/pydoc/index.html`) |
| `README.md`, `DATA_AUDIT.md`, `RESULTS.md`, `MLSD.md`, `MANIFEST.sha256.json` | `reference/initial-solution/` | Сохранены побайтно как оригинальная документация и provenance; вынесены из authored docs |
| `docs/dataset_README.md` | — | Не перенесён: SHA-256 совпадает с `dataset/README.md` |
| `docs/Emulator-and-Telematic-Packets-Specification.md` | — | Не перенесён: SHA-256 совпадает с официальной спецификацией из `dataset` |
| `.DS_Store` | — | Исключены как системный мусор |

## Официальная постановка

| Исходный путь | Целевой путь | Решение |
|---|---|---|
| `~/Downloads/Предиктор изменений в графике движения городского транспорта.pdf` | `docs/source/official/transport-delay-predictor.pdf` | Скопирован без изменений под стабильным именем |

## Создано в новом репозитории

`README.md`, `.gitignore`, `docs/repository-layout.md`, `docs/source-map.md`, `notebooks/README.md` и `dashboard/README.md` созданы для навигации и фиксации границ. Они не являются частью исходных материалов.
