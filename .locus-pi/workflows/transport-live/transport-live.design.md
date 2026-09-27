# Design: transport-live

Purpose: Выполнить T-6 до работающего потока NDTP и карты задержек Москвы, независимо проверенных по официальному scorecard.
Input: принятый запрос пользователя и уточнение о разрешённом OAuth/подписочном доступе.
Primary output: `completion.md` в явно выбранном task-owned .tasks/T-6-2026-09-26-ndtp/artifacts/workflow. Запуск обязан выбрать этот --output-dir; saved child использует тот же literal outputDir, key delivery и frozen keys [delivery].
Evidence boundary: агенты читают реальный репозиторий, task.md, документацию и результаты тестов; исходник workflow не читает файлов и не интерпретирует отчёты.
Pattern: fixed graph с bounded refinement, поскольку две продуктовые части известны, а review может вернуть конкретные исправления.
Brief detail: outcome-led.
Context: /Users/ravius/projects/transport2, ветка dev; задача .tasks/T-6-2026-09-26-ndtp/task.md. Пользовательские .idea/ и T-5 не изменять.
Executors: проверенные в pi --list-models selectors openai-codex/gpt-6-sol, openai-codex/gpt-6-astra, openai-codex/gpt-5.6-sol, claude-code/opus5-review. Авторизация: openai-codex OAuth, claude.ai/Max, явно разрешены пользователем. Фактический executedModel читается из runtime evidence после запуска.

Namespace: `runnable root`.

## Entries

| Ref | Entry kind | Responsibility | Invoked by |
| --- | --- | --- | --- |
| transport-live | runnable root | Проектирование и независимый plan gate | operator |
| transport-live/delivery | direct child | Поток, карта, review, QA и исправления | root после plan gate |

## Algorithm

1. Sol читает контекст, решает совместимость эмулятора/модели и картографии, уточняет task.md через locus-plan. В каждом цикле учитывает сохранённый полный plan-review.md.
2. Astra независимо проверяет task и design/source, сохраняет plan-review.md и записывает настоящий review-plan event. Возвращает choice ready/revise/blocked. Только ready с актуальным положительным gate допускает planned и вызов delivery; blocked и исчерпание трёх циклов заканчиваются ok:false.
3. В delivery Sol выполняет поток/время/модельный контракт, затем отдельный Sol строит карту по этому контракту. Они не работают одновременно и не отменяют чужие изменения.
4. GPT-5.6 Sol и Opus параллельно проверяют полный in-scope diff без изменения продукта и без управления контейнерами. Сохраняют раздельные отчёты.
5. Отдельный Sol последовательно проверяет работающий сервис, браузер, 15 минут потока, recovery и официальный scorecard. QA не редактирует продукт.
6. Astra читает весь evidence, примиряет findings, сохраняет arbitration.md, возвращает ready/revise/blocked. Ready допускает завершающий отчёт; revise возвращает конкретные замечания обоим исполнителям; blocked или третий неудовлетворительный цикл остаются незавершённым результатом.
7. Sol документирует принятый сервис, отмечает фактически выполненные work items/QA через CLI и публикует completion.md. Не коммитит, не пушит и не публикует без отдельного указания.

| Node | Responsibility | Receives | Returns | Next |
| --- | --- | --- | --- | --- |
| plan | Контракт и решения | input, task, prior plan-review.md | полный отчёт | plan-gate |
| plan-gate | Независимая проверка | план, реальный task/diff | ready/revise/blocked + plan-review.md | delivery / plan / stop |
| stream | Поток и runtime | задача, план, prior arbitration.md | полный handoff | map |
| map | Карта и UX | задача, stream handoff | полный handoff | reviews |
| technical-review | Корректность/поддерживаемость | реальный diff, handoffs | полный review | qa |
| opus-review | Независимый challenge | реальный diff, handoffs | полный review | qa |
| qa | Поведение/scorecard | оба review, реальный сервис | полный QA | arbitrate |
| arbitrate | Оценка и возврат исправлений | reviews, QA, предыдущий arbitration.md | ready/revise/blocked + arbitration.md | finish / stream / stop |
| finish | Документация и task readback | одобренный evidence | completion.md | end |

Concurrency: только два review без product writes и контейнерных мутаций. Остальное последовательно.
Loop bounds: 3 цикла plan и 3 цикла delivery, чтобы после повторяющихся замечаний сохранить evidence и провести диагностику вместо бесконечной переделки.
Budgets: none — launch defaults apply; иных ограничений нет.
Declared sizes: none.
File boundary: workflow не читает файлы; каждый агент сам читает обязательные источники и пишет только в своей границе.
Worst-case calls: 3×2 + 3×6 + 1 = 25 model calls, без транспортных retry; same-session format repair не новая agent call.
Failure exits: ошибки моделей/инструментов и недоступный required review не перехватываются; blocked/round limit возвращают ok:false. Успешный код возврата не заменяет приёмку продукта.
Mechanisms: один saved child, один parallel barrier, два конечных цикла, choices непосредственно от судей; комментарии и отчёты не парсятся.
Supervisor: retained tmux сохраняет Pi доступным; heartbeat в текущем Codex-чате проверяет журнал/результат раз в 10 минут, молчит без существенных изменений и сообщает о failure/completion/action. Сам heartbeat не создаёт конкурирующего исполнителя.
Status: REVIEWED — автор проверил соответствие accepted draft и DSL; независимая Astra дополнительно проверяет design/source перед реализацией.
