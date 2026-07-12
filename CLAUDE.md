# workday

Трекер рабочего времени: демон следит за git-активностью (poll ~30s), детектит сессии, считает stamina-score (адаптивный EMA), пишет дневные JSON-логи и пушит таймшиты в Tempo.

> **Фаза (июль 2026):** курс на always-on демон (24/7, lazy day, activity-gated sessions) — план `D:/notes/personal/workday/plans/always-on-daemon.md`, пакеты G+A–F (G сделан: Budget v2 = полное 24h-окно, set-start удалён — daemon v0.9.0 / tray-v0.12.0). НЕ возвращать: eager session open, unconditional flush, dayStart-anchored validation, set-start.

## Два деливерабла в одном репо

| | Демон | Tray-app |
|---|---|---|
| Код | `src/` (TS, ESM, **zero runtime deps**, Node ≥20) | `tray-app/` (Tauri v2 + Angular 19; Rust в `src-tauri/`) |
| Артефакт | npm `workday-daemon` (только `dist/`, bin `workday`) | GitHub Releases (NSIS/dmg), auto-updater `latest.json` |
| Версия | `package.json` | `tray-app/src-tauri/tauri.conf.json` (`tray-app/package.json` = 0.0.0, не используется) |
| Релиз | `npm publish` — ТОЛЬКО пользователь вручную (у Claude нет npm auth) | push тега `tray-v<version>` → CI `.github/workflows/release-tray-app.yml` |

**⚠ Публичный репозиторий:** не использовать реальные имена клиента/продукта/внутренних проектов в коде/тестах/моках/комментариях — только нейтральные плейсхолдеры (ключ `ATL` как обобщённый плейсхолдер допустим; `*.atlassian.net` — домен вендора Jira, ОК).

**Три независимые версии** (см. память reference_versioning_scheme): `API_VERSION` (`src/core/constants.ts`) — HTTP-контракт демон↔tray, tray проверяет **exact-match** (`EXPECTED_API_VERSION` в `tray-app/src/app/models/workday.models.ts`) — менять строго парой; npm-версия демона; tray-версия. Одинокий bump API_VERSION = reinstall-loop у tray.

## Структура

- `src/core/` — types, constants, config, daily-log (atomic writes), activity-evaluator (stamina), session-tracker, commit-ledger, update-manager, notification-center (desktop-тосты: правила + state machine; tray доставляет при presence)
- `src/collectors/` — git-client, git-tracker, reflog-parser, snapshot-parser, churn-scanner, ledger-collector
- `src/push/` — tempo-client, jira-client, tempo-pusher, report-builder, activity-types
- `src/daemon.ts` / `src/cli.ts` / `src/http-server.ts` — HTTP API только на `127.0.0.1:9213`
- `tray-app/src/app/views/` — day-view (+ session-card, duration-field), settings-view, timesheets-view
- `legacy/` — прототип на .mjs: read-only справка, НЕ подключать и НЕ править
- `ROADMAP-timesheet.md` — исторический, НЕ отражает текущее состояние (канон = код + README + docs/)

## Данные и секреты

- Пользовательские данные: `~/.workday/` (config.json, secrets.json, data/YYYY-MM/MM-DD.json); в репо `data/`, `config.json`, `secrets.json` — git-ignored dev-копии.
- **`secrets.json` содержит живые Jira/Tempo токены: НЕ читать содержимое, НЕ выводить в чат/логи, НЕ коммитить.** Структура — в `secrets.example.json`.

## Правила разработки

- Tray — display-only: никогда не стартует/не стопит демона сам.
- CLI — источник истины API: новая CLI-команда → метод в `WorkdayApiService`/`HttpWorkdayApiService` + зеркало типа в `workday.models.ts` тем же изменением.
- Все tray-действия через `runAction()` gate; навигация — signal-based, Angular Router НЕ ставить.
- Evidence baseSha = HEAD сессии, НЕ merge-base (ре-введение = баг «вся ветка как сегодняшняя работа»).
- Хранение — JSON-файлы с atomic write (tmp+rename), БД не вводить.
- Enum'ы: PascalCase-ключи со string-значениями; константы в `src/core/constants.ts`.
- Tray UI работа завершается по умолчанию: bump версии + commit + тег `tray-v<version>` + push тега (без push тега CI не стартует).
- Подписанные коммиты: если gpg падает — сначала `gpg-connect-agent /bye`; `gh` CLI отсутствует, GitHub Actions проверять через REST API.

## Верификация

- Типы: `npx tsc --noEmit` (корень; tray-app собирается через `npx ng build` в `tray-app/`).
- Тесты: `npm test` (plain tsx-тесты в `tests/unit` + `tests/integration`, без фреймворка).
- Обязательное чтение перед правкой алгоритмов: `docs/activity-algorithm.md` (stamina/EMA/leadership), `docs/commit-accounting.md` (ledger-инварианты), `docs/auto-update.md` (релизы/самообновление).
