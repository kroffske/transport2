# Планирование T-4

## Q0: Goal alignment

Question: нужен ли системный контур и когда его активировать?
Source check: `.locus/soul.md`, `.locus/goal.md`, `.locus/roadmap.md`, `docs/prd/evaluation-scorecard.md`.
Answer: T-4 необходим для C2–C5, но его API зависит от финального model contract T-3.
Status: source-proven
Direction: on-track
Consequence: задача остаётся draft; реализация начинается после T-3/evaluation contract.


## Q1: Перепланирование по запросу 2026-09-26

Question: что реализуется сейчас после нового ML evidence?
Source check: handoff, service.py/inference.py/features.py/data.py, compose.yaml, final_model.py/pipeline.py, data README/NDTP spec, прямое поручение пользователя.
Answer: старое ожидание model contract заменено W1, полный dashboard отложен. Единственный действующий контракт — обновлённый task.md; исходный draft и Q0 выше сохраняют историю.
Status: accepted-by-user
Consequence: T-4 готовится к исполнению сейчас; W1 первым, W2 по стабильной packet schema параллельно; W3 после обоих, затем W4/W5.

## Q2: Pressure pass — причинность и ложный успех

Question: может ли план пройти проверки без настоящей интеграции?
Source check: старый Predictor требует q10/q90; новый artifact direct-only; FeatureBuilder.history фильтрует event/receive; emulator timestamp задаётся автоматически; points.cur_dev_s дан извне.
Answer: обязательны независимый ML API parity, реальный TCP NDTP, самостоятельный computed-cur-dev путь и отдельный provided-hint benchmark. Отрицательный receive lag сохраняется; доступность требует обеих меток. Новая дата эмулятора явно unsupported. Wire quantization не смешивается с exact API parity.
Status: source-proven
Consequence: W1/W3/W4 имеют разные проверки; калиброванный риск, online MAE и onset lead-time нельзя выводить из старых/офлайн результатов.

## Q3: Владение и простая форма

Question: какие границы нужны реальному caller?
Source check: текущий FastAPI request уже содержит point/history/plan; один FeatureBuilder владеет causal windows, Backend отсутствует.
Answer: Backend state → HTTP point/history/plan → transport_ml feature/model → Backend snapshot → HTTP polling consumer. Stateful Backend и stateless ML оправданы официальным контрактом. Broker, DB, websocket и отдельная общая domain library не нужны для локального запуска. Географический контракт не добавляет runtime карту.
Status: assumption
Consequence: выбран минимальный проверяемый runtime; пересмотреть storage только при требовании restart persistence/multi-instance, не заранее.

## Q4: Источники и проверка географии

Source check: pandas scan всех трёх schedule и traffic; validate 5558 schedule rows, 13 vehicles, 847 unique geom, 0 missing coordinates; 105945 traffic rows, 6434 negative receive lag; unit→tr conflicts внутри каждого split = 0. Train содержит 39 ТС с синтетикой. SHA актуальной модели совпал с handoff.
Answer: координаты подходят для отображения имеющейся выборки, но не для полной сети Москвы. Георешение вынесено в docs/runbooks/geography-foundation.md с первичными источниками.
Status: source-proven
Consequence: stable stop/route identity и road geometry — будущая работа, не скрытая предпосылка текущей интеграции.
