# Workday

Фоновый daemon, который трекает рабочую активность через git (diff dynamics, reflog) и собирает данные в JSON-файлы по дням.

## Требования

- Node.js 20+
- npm

## Установка

```bash
npm install
```

## Настройка

**config.json** — репозитории и параметры:

```json
{
  "repos": ["D:/projects/atlas-frontend", "D:/projects/appone-backend"],
  "dayStart": "13:00",
  "taskPattern": "ATL-\\d+",
  "session": { "diffPollSeconds": 30 }
}
```

**secrets.json** — токены (gitignored):

```json
{
  "Developer": "atemnov",
  "Jira_Email": "...",
  "Jira_BaseUrl": "https://...",
  "Jira_Token": "...",
  "Tempo_Token": "..."
}
```

## Запуск

```bash
# Foreground
npx tsx src/cli.ts daemon

# Background
npx tsx src/cli.ts daemon --background

# Остановить
npx tsx src/cli.ts daemon stop
```

## Что делает

Каждые 30 секунд для каждого репозитория:

1. Выполняет batched git-вызов (`rev-parse`, `diff --numstat`, `status --porcelain`, `reflog`)
2. Фильтрует по ветке разработчика (содержит имя из `secrets.json`)
3. Вычисляет дельту изменений между снапшотами (dynamics)
4. Управляет сессиями: IDLE → PENDING (checkout) → ACTIVE (dynamics/commit)
5. Пишет результат в `data/YYYY-MM/MM-DD.json` (atomic write)

Смена дня детектируется автоматически (граница — 4:00). Сессии восстанавливаются после краша.

## Структура данных

Дневной лог (`data/2026-02/02-27.json`):

```json
{
  "date": "2026-02-27",
  "status": "draft",
  "dayType": "workday",
  "sessions": [
    {
      "id": "a1b2c3d4",
      "repo": "atlas-frontend",
      "task": "ATL-6466",
      "branch": "ATL-6466-atemnov-implement-fees",
      "state": "active",
      "startedAt": "2026-02-27T14:23:00.000Z",
      "endedAt": "2026-02-27T19:30:00.000Z",
      "evidence": { "commits": 4, "dynamicsHeartbeats": 67, "totalSnapshots": 102 }
    }
  ],
  "signals": [...]
}
```

## Что ещё не реализовано

- `workday status` / `workday today` — просмотр собранных данных
- `workday review` — интерактивное подтверждение
- `workday push` — отправка в Tempo
- Jira / Teams интеграция
- Confidence scoring, overlap resolution
