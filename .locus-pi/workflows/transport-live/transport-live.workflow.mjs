export const meta = {
  name: "transport-live",
  description: "T-6: проектирование, независимый gate и выполнение потока NDTP с картой",
  profile: "standard",
};

const AGENTS = {
  planner: { model: "openai-codex/gpt-6-sol" },
  reviewer: { model: "openai-codex/gpt-6-astra" },
};

export default async function run({ agent, phase, invokeWorkflow }, input) {
  for (let planRound = 1; planRound <= 3; planRound += 1) {
    phase("Проектирование");
    const plan = await agent(`Выполни проектирование T-6 через $locus-plan; продукт пока не изменяй. Вход пользователя: ${input}
Задача: .tasks/T-6-2026-09-26-ndtp/task.md. Parent goal: Получить локальный Docker-сервис с длительным потоком NDTP, осмысленными прогнозами задержек и интерактивной картой Москвы на Three.js, проверенный независимыми агентами по официальным критериям.
Contribution: снять неопределённости совместимости эмулятора, модели и карты. Proxy result: красивый план без реализуемой цепочки официального эмулятора неприемлем.
Прочитай task.md, .locus/soul.md, goal.md, roadmap.md, docs/prd, docs/runbooks, реальных владельцев transport_backend/transport_ml/consumer/scripts. Используй $code-standard. Найди готовую картографическую основу совместимую с Three.js и проверь текущую документацию/лицензии первичными источниками. Исследуй официальный Docker-эмулятор и возможность управляемого сценария через API, явную связь UTC с историческим планом/моделью, без скрытой подмены времени и утечки будущего. Это разрешённая локальная задача, не нужен новый human gate для обычных технических решений.
Уточни контракт T-6: owner, реальный caller, time semantics, интерфейс, сценарии, failure paths, 15-минутный прогон и критерии C3-C5. Не обещай C1/C2 без соответствующего evidence. Если существует plan-review.md в текущем workflow workspace, прочитай и устрани замечания текущего цикла ${planRound}. Сохрани обоснование в planning.md задачи при необходимости; mandatory решения держи в task.md. Не меняй runtime, .idea/, T-5, глобальные настройки; не выполняй commit/push. Ты не один в репозитории: сохраняй чужие изменения. Верни полный handoff для независимого reviewer.`, {
      ...AGENTS.planner, label: "plan", title: "Спроектировать поток и карту по фактическим контрактам",
    });
    const planRoute = await agent(`Независимо проверь сформированный план T-6 через $locus-plan-review, не редактируя продукт и не принимая обещания за evidence. Вход: ${input}
Отчёт планировщика: ${plan}
Прочитай фактический task.md .tasks/T-6-2026-09-26-ndtp/task.md, код по спорным решениям и .locus-pi/workflows/transport-live/transport-live.design.md плюс оба .workflow.mjs. Проверь реализуемость официального эмулятора, честность часов/модели, Three.js и карты, сохранение accepted scope, качество проверки. Текущий OAuth/подписочный доступ явно разрешён пользователем; OpenRouter не использовать.
Сохрани полный независимый review в plan-review.md текущего workflow workspace. Запиши настоящий locus task review-plan event: begin перед проверкой и результат после; используй --help и skill для допустимых verdict, без обхода required gate. Только актуальный положительный review позволяет перевести T-6 в planned. ready означает current favorable plan gate; revise означает конкретные устранимые замечания; blocked означает конкретное препятствие, которое нельзя решить в разрешённом scope. Не требуй повторного согласования accepted draft. Верни соответствующий choice.`, {
      ...AGENTS.reviewer, label: "plan-gate", title: "Независимо проверить план и workflow", choice: ["ready", "revise", "blocked"],
    });
    if (planRoute === "ready") {
      return invokeWorkflow({
        child: "delivery",
        input,
        key: "delivery",
        keys: ["delivery"],
        outputDir: ".tasks/T-6-2026-09-26-ndtp/artifacts/workflow",
      });
    }
    if (planRoute === "blocked") return { ok: false, status: "blocked", reason: "plan_gate_blocked" };
    if (planRound === 3) return { ok: false, status: "blocked", reason: "plan_round_limit" };
  }
}
