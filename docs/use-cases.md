# Use Cases: Activity Evaluator

Сценарии для ручной верификации алгоритма перед разработкой.
Все примеры: `diffPollSeconds=30`, тик = 30с, MIN_TIMEOUT=30 тиков (15 мин), MAX_TIMEOUT=90 тиков (45 мин).

---

## UC-1: Классический рабочий день (1 репо)

```
09:00  Daemon запущен. Сессия A открыта (Pending), score=0.
09:00  Первый dynamics → score=46.5, единственная сессия, score>0 → лидер → Active.
       startedAt = 09:00.
09:00-12:00  Непрерывная работа, dynamics каждый тик.
       EMA → 1.0, dynamicMax=30, score=30 (cap).
12:00  Ушёл на обед. Последний dynamics.
12:15  score=0 → IdleTimeout. Pause { from: 12:15, source: idle_timeout }.
13:00  Вернулся, первый dynamics.
       EMA затухла до ~0. dynamicMax≈90, activityPoints≈46.5.
       score=46.5 > 0, единственная сессия → лидер.
       Pause closed { to: 13:00 }. Трекинг продолжается.
13:00-17:30  Работа с перерывами на чай (~5 мин, score не успевает дойти до 0).
17:30  Последний dynamics.
17:45  score=0 → IdleTimeout.
18:00  workday stop → сессия закрыта (ClosedBy.DaemonStop).

Итого: ~7.5ч реального времени, минус обед (45 мин) и чайные паузы.
```

**Проверяем:** обед корректно вычтен через IdleTimeout. Чайные паузы < 15 мин не вызвали паузу.

---

## UC-2: Медленный code review (1 репо)

```
10:00  Checkout на ветку коллеги для ревью. Сессия A открыта (Pending).
10:00-10:40  Читает код, нет dynamics. Score=0.
       Сессия остаётся Pending. Никаких пауз (нечего паузить).
10:40  Оставил один комментарий в коде (1 строка). Dynamics.
       score=46.5, единственная сессия → лидер → Active. startedAt=10:40.
10:55  Ещё комментарий (dynamics). score пополняется.
11:10  Переключился на свою ветку → checkout → ClosedBy.CheckoutOtherTask.

Итого A: startedAt=10:40, closed=11:10, duration=30 мин.
40 минут чтения без правок НЕ залогированы (Pending).
```

**Проверяем:** Pending-период (10:00-10:40) не учтён. Только реальная работа.

---

## UC-3: Переключение между двумя репо (одна задача ATL-123)

```
09:00  Работаю в frontend (A). Active, score=30, EMA=1.0, dynamicMax=30.
10:30  Переключился на backend (B), начал API endpoint.

10:30:00  Тик 1: B dynamics. B score=46.5, norm=0.53. A score=29, norm=0.97.
          A лидер. B — Pending.
10:30:30  Тик 2: B dynamics. B norm=1.00. A norm=0.93. B > A → B лидер!
          B: Pending → Active, startedAt=10:30:30.
          A: Pause(Superseded).
11:30  Вернулся в frontend (A). Dynamics в A.
       A: auto-resume (dynamics на паузе), score пополняется.
       A norm > B norm → A лидер. B: Pause(Superseded).
12:00  Обед.

Итого дня:
  A: 09:00-10:30:30 (active), 10:30:30-11:30 (superseded), 11:30-12:00 (active)
  B: 10:30:30-11:30 (active), 11:30+ (superseded → idle_timeout)
  Задача ATL-123: A + B = ~3.5ч (без пересечений)
```

**Проверяем:** пересечение = 0. Время группируется по задаче корректно.

---

## UC-4: Стрей dynamics во время звонка (2 репо)

```
14:00  Активно работаю в A (лидер, score=30, norm=1.0).
14:20  На звонке. Случайно задел клавишу в B, сохранил файл. 1 строка.
       B: score=46.5, norm=0.53. A: score=20 (decay 10 тиков), norm=0.67.
       A(0.67) > B(0.53) → A по-прежнему лидер.
       B остаётся Pending.
14:20+  B score затухает до 0. Сессия B закрывается как Pending.

Итого: стрей не повлиял на A. B исключена из отчёта.
```

**Проверяем:** случайное касание не крадёт лидерство. Нормализация защищает.

---

## UC-5: Ручная пауза + забыл resume (1 репо)

```
12:00  Активно работаю. A: Active, score=28, EMA=0.9.
12:01  workday pause → ручная пауза. Evaluator заморожен (score=28, EMA=0.9).
12:01-13:30  Обед + митинг. Score заморожен на 28.
13:30  Забыл нажать resume. Открыл IDE, начал кодить.
13:31  Dynamics в A.
       SessionTracker: "ручная пауза, но есть активность → закрываю паузу".
       Pause { from: 12:01, to: 13:31, source: manual }.
       Evaluator размораживается: score=28, EMA=0.9.
       +activityPoints → score=28+19.5=47.5, cap 30 → 30.
       Нормальная работа продолжается.

Итого: 1.5ч паузы корректно записаны. Авто-resume при git-активности сработал.
```

**Проверяем:** замороженный score = естественный grace period. Забытый resume не потерял время.

---

## UC-6: autopause off для чтения документации (1 репо)

```
13:00  Вернулся с обеда. workday resume → паузы закрыты.
       A: Active, score≈0 (после IdleTimeout), EMA≈0.
13:00  workday autopause off → IdleTimeout подавлен.
13:00-14:30  Читает документацию, нет git-изменений.
       score=0, но IdleTimeout подавлен. A — единственная сессия, лидер по умолчанию.
       Время логируется (1.5 часа).
14:30  Начал кодить → dynamics. score пополняется.
14:30  workday autopause on → нормальное поведение.

Итого: 1.5ч чтения засчитаны благодаря autopause off.
```

**Проверяем:** autopause off позволяет трекать «бескодовую» работу. Superseded всё ещё работает (если бы был конкурент).

---

## UC-7: Быстрый пинг-понг frontend/backend (2 репо, одна задача)

```
10:00  Работаю в A (frontend). Active, лидер.
10:05  Переключился в B (backend). 2 тика dynamics → B лидер.
       A: Superseded. B: Active.
10:10  Вернулся в A. 1 тик dynamics → A norm=1.0 > B norm.
       A лидер. B: Superseded.
10:15  Снова в B. 2 тика → B лидер. A: Superseded.
10:20  Обратно в A. 1 тик → A лидер.

За 20 минут: 4 переключения.
Каждое создаёт/закрывает Superseded паузу.
Задача ATL-123: суммарное время из A + B = 20 мин (корректно).
```

**Проверяем:** частые переключения корректно обрабатываются. Отчёт по задаче суммирует обе сессии.

---

## UC-8: Три репозитория (разные задачи)

```
09:00  Работаю в A (ATL-100). Active, лидер.
10:00  Переключился в B (ATL-200). 2 тика → B лидер.
       A: Superseded. B: Active.
11:00  Срочный баг в C (ATL-300). Переключился. 2 тика → C лидер.
       A: Active(Superseded) — score давно 0 → ещё и IdleTimeout.
       B: Superseded. C: Active.
11:30  Баг пофикшен. Вернулся в B. Dynamics → B лидер.
       C: Superseded.
12:00  Вернулся в A. Dynamics → A лидер.
       B: Superseded → затухает → IdleTimeout.
       C: уже IdleTimeout.

Итого:
  ATL-100: 09:00-10:00:30 + 12:00+
  ATL-200: 10:00:30-11:00:30 + 11:30-12:00
  ATL-300: 11:00:30-11:30
  Пересечений: 0.
```

**Проверяем:** три репо, три задачи, лидерство переходит корректно. Никаких пересечений.

---

## UC-9: Daemon crash и восстановление (1 репо)

```
14:00  Работаю. A: Active, score=25, EMA=0.8.
14:05  Daemon упал (kill -9). In-memory состояние потеряно.
14:10  Daemon перезапущен.
       SessionTracker: находит открытую сессию A (без closedBy).
       closeCrashedSessions(): A.closedBy = DaemonCrash, lastSeenAt сохранён (≈14:05).
       Новая сессия A2 открыта (Pending). Evaluator: score=0, EMA=0.
14:10  Первый dynamics → A2: score>0, единственная → лидер → Active.
       startedAt=14:10. dynamicMax=90 (щедрый — EMA=0, потеряли историю).

Итого: A: 09:00-14:05 (closed: daemon_crash). A2: 14:10+ (fresh start).
Потеряно: ~5 мин (14:05-14:10).
```

**Проверяем:** crash recovery безопасен. Потеря ~5 мин — приемлемо.

---

## UC-10: Граница дня (ночной daemon, 1 репо)

```
23:00  Последний dynamics. Score=30.
23:15  score=0 → IdleTimeout.
04:00  dayBoundaryHour=4. Граница дня.
       Все сессии закрыты (ClosedBy.DayBoundary).
       Evaluator state обнулён. Новый DailyLog создан.
08:00  Разработчик пришёл, первый dynamics.
       Новая сессия (Pending → Active). Свежий день.

Итого вчера: работа до 23:15 (с idle timeout), ночь не залогирована.
```

**Проверяем:** IdleTimeout + day boundary корректно обрезают рабочий день.

---

## UC-11: Лёгкий кодер vs тяжёлый конкурент (2 репо)

```
09:00  Работаю в A (лёгкий: 1 dynamics / 15 мин).
       EMA≈0.05, dynamicMax≈87, score≈70 (накопилось за несколько циклов).
09:50  Переключился в B, начал интенсивно кодить (каждый тик).
       Тик 1: B score=46.5, norm=0.53. A score=60, norm=60/87=0.69.
       A(0.69) > B(0.53) → A всё ещё лидер!
       Тик 2: B score=87(cap), norm=1.00. A score=59, norm=0.68.
       B(1.00) > A(0.68) → B лидер.
       A: Superseded.
10:00  B работает. A score продолжает затухать (не заморожен).
10:20  Вернулся в A. dynamics.
       A score был ≈35 (затухал от 59). +activityPoints≈46.5 → 81.5, cap 87 → 81.5.
       A norm=81.5/87=0.94. B (если перестал): score≈67, norm=67/30=...

       Стоп — B: EMA≈1.0 (тяжёлый), dynamicMax=30. score после 20 мин затухания: 30-40=0.
       Нет, B score не может быть отрицательным. B score=0 → IdleTimeout.

       Значит A(0.94) лидер. A продолжает.

Итого: лёгкий кодер не теряет время, когда конкурент уходит.
```

**Проверяем:** нормализация позволяет лёгкому кодеру (norm=0.69) удерживать лидерство против первого dynamics конкурента (norm=0.53). Но устойчивая активность конкурента (norm=1.0) побеждает.

---

## UC-12: Ручная пауза на ручной паузе (edge case)

```
10:00  A: Active, лидер.
10:05  workday pause → ручная пауза. Evaluator заморожен.
10:10  workday pause (повторно) → сессия уже на паузе. Игнорируем (идемпотентно).
10:20  workday resume → пауза закрыта.
       Evaluator размораживается с сохранённым state.

Итого: повторная пауза не создаёт дубликатов. Resume работает корректно.
```

**Проверяем:** идемпотентность команд.

---

## UC-13: Checkout на чужую ветку во время работы (1 репо)

```
10:00  Работаю в A на ветке atemnov/ATL-123. Active, лидер.
10:30  git checkout develop (для pull).
       GitTracker: task=null (develop — genericBranch).
       SessionTracker: task=null → closeSession(A, CheckoutOtherTask).
       A закрыта. Evaluator: removeSession(A).
10:31  git checkout atemnov/ATL-123 (обратно).
       Новая сессия A2 (Pending). Evaluator: score=0, EMA=0 (чистый старт).
10:31  Dynamics → A2: Active, лидер.

Итого: A: 10:00-10:30, A2: 10:31+. 1 мин потеряна (checkout + return).
```

**Проверяем:** checkout на generic branch корректно закрывает сессию. Возврат — новая сессия.

---

## UC-14: Два репо, оба Pending, кто станет Active?

```
09:00  Daemon запущен. A открыта (Pending), B открыта (Pending).
       Обе score=0. Нет лидера (leaderId=null).
09:05  Dynamics в A (5 строк). A score=48.2. B score=0.
       A score>0, A — наивысший → A лидер → Active. startedAt=09:05.
09:05  Одновременно dynamics в B (10 строк). B score=50.5.
       ...но обработка тиков последовательная.

       Правильнее: processAllTicks() обрабатывает обе за один вызов.
       A score=48.2, norm=48.2/87=0.55.
       B score=50.5, norm=50.5/87=0.58.
       B(0.58) > A(0.55) → B лидер → Active. A остаётся Pending.

Итого: при одновременном первом dynamics побеждает тот, у кого выше normalizedScore.
```

**Проверяем:** конкуренция Pending-сессий работает корректно. Первый лидер определяется за один тик.

---

## UC-15: autopause off + переключение на другой репо

```
10:00  A: Active, лидер. workday autopause off (для A).
10:00-11:00  Читает код в A, нет dynamics. Score=0, но IdleTimeout подавлен.
11:00  Начал кодить в B. Dynamics.
       B score=46.5, norm=0.53.
       A score=0, norm=0.
       B(0.53) > A(0) → B лидер!
       A: Superseded (autopause off не защищает от Superseded).
       B: Pending → Active.

11:30  Вернулся в A. Dynamics.
       A: Superseded закрыта (resume). score пополняется.
       A norm > B norm → A лидер.
       B: Superseded.

Итого: autopause off не даёт бесконечное лидерство — Superseded всё равно работает.
       Это правильно: нельзя быть лидером двух репо одновременно.
```

**Проверяем:** autopause off подавляет IdleTimeout, но НЕ Superseded. Защита от «забыл включить обратно».
