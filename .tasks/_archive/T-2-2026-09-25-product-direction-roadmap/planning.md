# Планирование T-2

## Q0: Goal alignment

Question: служит ли T-2 принятому направлению проекта и не подменяет ли продукт документацией?
Source check: явное поручение пользователя в текущей сессии; официальный PDF; `data/README.md`.
Answer: пользователь определил стратегическое направление: официальные критерии становятся основой roadmap и оценки готовности; ближайший практический приоритет — честный ML-результат на полном датасете; системный контур оформляется отдельно.
Status: accepted-by-user
Direction: on-track
Consequence: T-2 создаёт source-of-truth и исполнимые T-3/T-4, но не выполняет модельное или системное строительство.

## Source map

- `docs/source/official/transport-delay-predictor.pdf` — неизменяемый официальный источник, 6 страниц.
- `data/README.md` — точный контракт прогнозной точки, point-in-time-правило, формат submission и метрика.
- `reference/initial-solution/MLSD.md` — полезный проектный анализ начального решения, но не официальный источник и не доказательство на полном датасете.
- `docs/prd/transport-delay-predictor.md` — рабочая Markdown-транскрипция официального документа.
- `docs/prd/evaluation-scorecard.md` — производная operational view для приоритизации и доказательств.

## Placement decision

PDF не превращается в `soul.md`: soul находится уровнем выше требований конкретного хакатона. Полный текст идёт в PRD, scorecard владеет критериями, soul формулирует миссию и ссылается на scorecard, roadmap связывает критерии с этапами и задачами.

## Agent shape

- T-2 использует одного Astra reviewer после локальной подготовки кандидата.
- T-3 планируется как parent task с отдельными дочерними срезами. Исполнение допускает параллельные read-only/worker legs только после фиксации контрактов данных и общей схемы эксперимента.
- T-4 отделён от ML, чтобы dashboard или Docker-placeholder не считались прогрессом модели и наоборот.

## Pressure pass

- Переписать PDF как краткое резюме — недостаточно: потеряются пороги баллов, требования к потоку, лимиты загрузок и артефакты сдачи.
- Использовать leaderboard score как единственную цель — proxy trap: можно получить хороший MAE без раннего предупреждения и системы из трёх модулей.
- Начать с сложной нейросети на малых данных — риск потратить время до честного baseline и проверки leakage.
- Создать пустые service/dashboard каталоги и назвать систему готовой — не подтверждает end-to-end критерий.
- Параллельно запускать независимые модели без общей схемы split/evaluation — результаты станут несопоставимыми.

## Handoff

Сначала создаются PRD, scorecard, soul, goal и roadmap. Затем создаются T-3/T-4 и ML children. После этого Astra получает закрытый read-only пакет и возвращает findings; только проверенные findings меняют source-of-truth.

## Astra review reconciliation

Review: `artifacts/astra-review.md`, verdict `revise`.

Приняты все четыре required edits:

1. `labels_test` помечен как ранее экспонированный диагностический набор; локальная оценка больше не называется новым unseen period.
2. C2 отделён от планового горизонта остановки; T-4 получил владельца onset/alert policy и lead-time evidence.
3. Local submission handoff разрешён сразу после T-3/evaluation, а platform upload/readback выделен как отдельная внешняя граница.
4. T-4 и Phase 4 получили владельцев PyDoc/Sphinx, OpenAPI, jury runbook и полного checklist обязательных артефактов.

Также приняты безопасные рекомендации: уточнён предварительный смысл «выполнимости», задачи связаны ссылками, data-audit разделяет CSV schema checks и hash комплектности, baseline проверяет received-time sensitivity и cutoff-before-dedup.
