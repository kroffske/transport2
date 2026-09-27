export const meta = {
  name: "transport-live/delivery",
  description: "T-6: поток, карта, независимые review и QA с возвратом исправлений",
  profile: "standard",
};

const AGENTS = {
  worker: { model: "openai-codex/gpt-6-sol" },
  reviewer: { model: "openai-codex/gpt-5.6-sol" },
  opus: { model: "claude-code/opus5-review" },
  arbiter: { model: "openai-codex/gpt-6-astra" },
};

export default async function run({ agent, parallel, phase, publishPrimaryArtifact }, input) {
  for (let deliveryRound = 1; deliveryRound <= 3; deliveryRound += 1) {
    phase("Поток NDTP");
    const stream = await agent(`Выполни backend/stream часть T-6 по .tasks/T-6-2026-09-26-ndtp/task.md через $locus-dev и $code-standard. Прочитай locus task state T-6 --json и приступай только при current favorable plan gate; разрешён переход planned→doing.
Parent goal: Получить локальный Docker-сервис с длительным потоком NDTP, осмысленными прогнозами задержек и интерактивной картой Москвы на Three.js, проверенный независимыми агентами по официальным критериям.
Contribution: осмысленный длительный поток событий до snapshot. Proxy result: одни accepted frames, unsupported_day или короткий replay не закрывают работу. Пользовательский вход: ${input}
Владение: transport_backend, нужная адаптация serving в transport_ml без переобучения/T-5, scripts, compose/Docker, stream tests, API/runbook. Ты не один: не отменяй чужие изменения, .idea/ не трогай. Прочитай принятый план и при повторном цикле ${deliveryRound} существующие arbitration.md, qa.md, technical-review.md, opus-review.md текущего workspace. Устрани только оставшиеся backend проблемы, сохраняя работающий UI. Используй официальный эмулятор и выбранный планом сценарий, явные часы, point-in-time данные, честные unavailable/degraded состояния и recovery. Сам запусти подходящие behavioral checks. Сохрани stream.md в workflow workspace и верни контракт/команды/evidence для UI-разработчика. Не меняй критерии приёмки, не делай commit/push/deploy и не запускай новых агентов.`, {
      ...AGENTS.worker, label: "stream", title: "Интегрировать длительный поток официального эмулятора",
    });
    phase("Карта Москвы");
    const map = await agent(`Реализуй или исправь UI часть T-6 через $locus-dev и $code-standard. Задача .tasks/T-6-2026-09-26-ndtp/task.md, принятый planning.md при наличии. Parent goal: Получить локальный Docker-сервис с длительным потоком NDTP, осмысленными прогнозами задержек и интерактивной картой Москвы на Three.js, проверенный независимыми агентами по официальным критериям.
Contribution: диспетчер за несколько секунд видит проблемный транспорт и понимает прогноз. Proxy result: mockup, статичные автобусы, таблица без карты или неизвестное состояние как нулевая задержка неприемлемы.
Вход: ${input}
Backend handoff: ${stream}
Владение: dashboard, consumer, frontend dependencies/build, UI Docker delivery и tests/runbook. Не переписывай backend, кроме необходимого согласованного исправления API, которое обоснуй. Ты не один: сохраняй чужие изменения, .idea/ и T-5 не трогай. На цикле ${deliveryRound} прочитай существующие arbitration.md/qa.md/technical-review.md/opus-review.md в workspace. Используй выбранную готовую геооснову Москвы и Three.js транспортный слой, реальные snapshot updates, панорамирование/масштаб, выбор автобуса, карточку остановки/прогноза/свежести, явный unknown и degraded. Не выдумывай маршруты, probability и причины. Проверь реальный браузер и отсутствие ошибок; сохраняй screenshot evidence. Сохрани map.md и верни полный handoff. Не коммить, не публикуй, не запускай других агентов.`, {
      ...AGENTS.worker, label: "map", title: "Построить интерактивную карту и карточки задержек",
    });
    phase("Независимые review");
    const reviews = await parallel([
      () => agent(`Независимое техническое review T-6 через $locus-code-review и $code-standard. Прочитай .tasks/T-6-2026-09-26-ndtp/task.md и весь фактический in-scope diff, включая новые untracked файлы, исключая .idea/ и T-5. Product source не редактировать, контейнерами не управлять: параллельно другой reviewer. Допустимы read-only проверки и запись technical-review.md в workspace. Проверь владельцев, временные инварианты, ошибки/recovery, согласованность API/UI, dependencies/licenses и необходимые tests. Не требуй абстракций без реального caller. Дай конкретные findings с путями/строками и критерием; явно отметь отсутствующее evidence.
Вход: ${input}
Поток: ${stream}
Карта: ${map}`, { ...AGENTS.reviewer, label: "technical-review", title: "Проверить код и контракты GPT-5.6 Sol" }),
      () => agent(`Независимый challenge T-6: .tasks/T-6-2026-09-26-ndtp/task.md, официальный PRD/scorecard, весь реальный in-scope diff включая untracked source. Работай через собственный Claude Code tool surface; ты не один, продукт и контейнеры не изменяй, не запускай новых агентов. Сохрани opus-review.md в workflow workspace. Проверь, доказано ли событие официального эмулятора→валидный прогноз→живая карта; время, утечки, синтетические данные, покрытие геоданных, unknown/risk semantics, правдивость claims. Дай concrete findings и evidence, не абстрактное одобрение. Подписочный доступ Claude Code явно разрешён.
Вход: ${input}
Поток: ${stream}
Карта: ${map}`, { ...AGENTS.opus, label: "opus-review", title: "Независимо проверить правдивость результата через Opus" }),
    ]);
    phase("QA и scorecard");
    const qa = await agent(`Проведи независимую проверку T-6 через $locus-qa. Продукт не редактировать; tests/evidence можно добавить в task artifacts. Прочитай task.md, официальный PRD/scorecard и фактический diff. Выполни реальные проверки: запуск Docker, минимум 15 минут wall-clock обновлений с осмысленными прогнозами от официального эмулятора, trace frame→prediction→snapshot, recovery источника/Backend/ML, корректность unknown/stale, реальные browser pan/zoom/selection/card и screenshots/console. Измерь latency с определением часов, выполни применимые tests. Прошлый 15-минутный evidence можно переиспользовать только если после него не менялся проверяемый путь; объясни применимость. Отдельно оцени C1–C5: C1 без platform readback и C2 без onset остаются ограничениями, не выдумывай баллы. Сохрани qa.md и артефакты в workspace; верни evidence и actionable defects. Не принимай заявленные исполнителем tests за собственную проверку. Не коммить/пушить, не запускать других агентов.
Вход: ${input}
Результат потока: ${stream}
Результат карты: ${map}
Независимые reviews: ${reviews.join("\n\n")}`, { ...AGENTS.worker, label: "qa", title: "Проверить работающий сервис, 15 минут потока и критерии" });
    const deliveryRoute = await agent(`Ты независимый арбитр T-6. Прочитай task.md, весь review/QA evidence и предыдущий arbitration.md, если он есть. Сохрани arbitration.md в workflow workspace: какие критерии подтверждены, какие замечания приняты/отклонены и почему, точный remaining scope для backend и UI исполнителей. Не редактируй продукт и не ослабляй accepted scope.
Вход: ${input}
Поток: ${stream}
Карта: ${map}
Reviews: ${reviews.join("\n\n")}
QA: ${qa}
ready допустим только когда все обязательные task criteria подтверждены независимой QA; текущие известные C1/C2 ограничения не превращай в fabricated success. revise означает конкретные исправления с ожидаемым observable evidence. blocked означает препятствие вне разрешённой работы либо повторную переделку без проверяемого прогресса. Цикл ${deliveryRound}. Возвращай choice, сохранив полный смысл решения в arbitration.md.`, { ...AGENTS.arbiter, label: "arbitrate", title: "Оценить результат и назначить необходимые исправления", choice: ["ready", "revise", "blocked"] });
    if (deliveryRoute === "ready") {
      const completion = await agent(`Заверши принятую T-6 через $locus-pm, $executive-summary и локальную границу $locus-ship. Прочитай task.md, qa.md/arbitration.md и реальное состояние. Продукт больше не меняй: только актуализируй README/runbook/scorecard по evidence, task work items/status и итоговый отчёт. Не повышай C1/C2 без нужного readback, не заявляй production readiness. Используй lifecycle CLI, не подделывай gate; если required gate отсутствует, честно сообщи и не закрывай задачу. Commit/push/PR/merge/deploy не выполнять. Верни полный completion.md на русском: что работает, запуск, проверка, ограничения, локальная доставка, фактическая ветка и незакоммиченные изменения.
QA: ${qa}
Вход: ${input}`, { ...AGENTS.worker, label: "finish", title: "Зафиксировать проверенный результат и способ запуска" });
      return publishPrimaryArtifact("completion.md", completion);
    }
    if (deliveryRoute === "blocked") return { ok: false, status: "blocked", reason: "delivery_gate_blocked" };
    if (deliveryRound === 3) return { ok: false, status: "blocked", reason: "delivery_round_limit" };
  }
}
