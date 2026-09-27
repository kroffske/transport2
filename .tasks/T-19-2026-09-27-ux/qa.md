# QA T-19: dispatcher UI after the T-15…T-18 merges

Verdict: FINDINGS

The P1 found on 4a8b059 (JS error, queue not re-rendering while an event is open) is fixed in 89e35cb. Nothing on 89e35cb blocks the merge. There is one open P2 (the attention text is cut off at 1366). Some items were not checked (V5, V9 focus-visible, V2 pan/zoom exactness, toasts under the T-14 filter), so the verdict cannot be ACCEPTED.

- Commits tested: **4a8b059** (first pass) and **89e35cb** (the current head of `ux/dispatcher-layout`, where all queue checks were repeated). The copy is detached in `scratchpad/wt-qa`, and `npm --prefix dashboard run build` was run before every pass.
- Harness: `qa/run.mjs` is `preview.mjs` from T-13 plus a mutable fixture (so the snapshot can change mid-run) and frozen `/api/route` from `T-16/artifacts/tools/fx/routes`. The page is served on the :8002 origin with interception. No new server or port was used, and docker was not touched.
- Fixtures:
  - `qa/main.mjs`: `fx/states.json` plus 40 clones. That gives 43 open events. Resolving 16 clones mid-run then puts 16 events into «Завершены».
  - `qa/states.mjs`: the W16 states. `warming` on 135081; hold on the same target on 133300; hold for a changed target on 133957; `lost` on 131672; a stale forecast on 122048; no forecast on 129964; no target on 130072.
- Evidence: `artifacts/qa/` holds 4a8b059, and `artifacts/qa/89e35cb/` holds 89e35cb. The logs are `qa/*.log`, and `main-*.log` / `states-1920.log` are from 4a8b059.

## Unit tests and build

| Check | Result |
| --- | --- |
| `npm --prefix dashboard test` at 4a8b059 | 108 pass / 0 fail |
| `npm --prefix dashboard test` at 89e35cb | 109 pass / 0 fail |
| `python -m pytest -q tests` at 4a8b059 | 105 passed, 7 skipped |
| `npm run build` | OK at both commits |

## Ledger (89e35cb unless noted)

| Requirement | Check | Size | Status | Evidence / Output |
| --- | --- | --- | --- | --- |
| REQ-1 pageerror = 0 | pageerror during every scenario | 1920, 1366 | PASS on 89e35cb; **FAILED on 4a8b059** | 4a8b059: 25 × `Cannot access 'shown' before initialization` (`main-1920.log`). 89e35cb: `PAGEERRORS 0` in all runs. The only console errors are 503s during the deliberate Backend-offline step. |
| REQ-2 §V1 | Open the third of 43 events. Check the columns, the target row and the labels inside the visible map zone. | 1920 | PASS | Columns: map 0–1120, card 1120–1560 (440 px), queue 1561–1920 (359 px). Target row y742–764 is visible. The ТС label (x659–798, y424–450), the ЦЕЛЬ label (x285–496, y567–593) and «след. ост.» (x228–445, y649–673) are all below the attention bar (≤111) and above the legend (≥949). See `89e35cb/1920-v1-open-134040.png` and `1920-02-open-third.png`. |
| REQ-3 §V2 | Queue width, card overlay, target row, map width after close | 1366 | PASS (partial) | Queue is 319 px. The card is 420 px over the map (x626–1046). The map width stays 1046 whether the card is open or closed. Target row y742–764 is visible (at the very bottom edge). Exact pan/zoom preservation was **не проверено**; the follow re-centre is the known, accepted P3. See `89e35cb/1366-v1-open-134040.png` and `1366-02-open-third.png`. |
| REQ-4 §V3 | J×4, then K | 1920, 1366 | PASS | The queue's `scrollTop` stays 0 on every step. Card and list widths do not change. `aria-current` moves 900137→136→135→134→133→134 (`f-main-*.log`, GEO lines). |
| REQ-5 §V4 | W, then Esc, then Esc | 1920, 1366 | PASS | After W the row stays in place with the «в работе» badge (`@work`, groups `needs:42`). The first Esc closes the card and keeps the selection. The second Esc clears the selection, and the row moves to «В работе» (`needs:42 work:1`). See `89e35cb/*-04-after-W.png`, `*-05-esc1.png` and `*-06-esc2.png`. |
| REQ-6 §V6 | No «с ЧЧ:ММ», no «задержка через N» | 1920, 1366 | PASS | Both body-text regexes return null in every state. The queue shows «открыто 07:41». |
| REQ-7 §V7 | Forecast states via fixture | 1920, 1366 | PASS | See `f-states-1366.log` and `89e35cb/1366-st-*.png` (and `1920-st-*.png` at 4a8b059).<br>• Updating: «Прогноз обновляется · последний результат для этой цели: +1 мин 40 с · 1 мин назад».<br>• Target change: «Новая цель: ост. 13 … Прошлый результат … К новой цели не относится».<br>• Stale: «Прогноз устарел … Не использовать как текущий».<br>• No forecast: «Прогноза для цели пока нет».<br>• No target: «Цель прогноза не выбрана», with a reason.<br>• Run over: «Данные на 07:41:14 прогон завершён», queue badge «прогон завершён».<br>• Offline: «Backend недоступен · последний снимок 1 с назад». |
| REQ-8 §V8 | Grayscale view of stop roles and ТС levels | 1366, 1920 | PASS | Stop roles are told apart by shape: grey dot, ring, diamond with flag, dashed ring. ТС levels are told apart by the «!» and «!!» badges. See `89e35cb/*-v1-grayscale.png`. |
| REQ-9 §V9 keys | J/K/W/S/C/Esc and `/` | 1920, 1366 | PASS | S snoozes («напомнить в 07:46»). C opens «Причина закрытия», and Esc closes the menu first while the card stays open. `/` focuses `#vehicle-search`, typing lists matches, and Enter opens the card. Every stop icon carries an aria-label (пройдена / до цели / цель прогноза / после цели, допущение). focus-visible was **не проверено**: Tab after Esc stayed on body, so the result is inconclusive. |
| REQ-10 §V10 | One delay format across map label, queue and card | 1920, 1366 | PASS | Queue: `+3:20`, «у ост. 11 · 07:52 → 07:55». Map: «134040 · опозд. +3:20» and «ЦЕЛЬ · ост. 11 · 07:52 → 07:55 · +3:20». Card: «+3 мин 20 с», and the target row shows `+3:20`. |
| REQ-11 Queue squash bug | 43 events, 16 of them «Завершены» (expanded) | 1920, 1366 | PASS | Row height is 59–74 px at 1920 and 59–127 px at 1366. No row is clipped, including after another 15 s on the page. The list scrolls (1366: ch 585 / sh 3981; 1920: ch 897 / sh 3148). See `89e35cb/*-ended-expanded-bottom.png` and `*-10-many-ended-bottom.png`. |
| REQ-12 T-14 «Мои маршруты» | Uncheck route R-b9ce8d (ТС 134040) | 1920, 1366 | PASS | Queue goes from [ТС 134040] to []. The attention bar changes to «Предупреждений нет». The vehicle count goes from 16 to 15. The map loses both 134040 labels. The list no longer contains 134040. The header shows «Маршруты: 13 из 14». Toasts under the filter were **не проверено** (the filter exists in the code, `event-queue.js` toasts filter). |
| REQ-13 W16 | warming, held, lost, frozen SLA | 1920, 1366 | PASS | • Warming: the card shows «По графику · прогноз готовится … примерно через 40 с», the list says «по графику · Прогноз готовится», the label reads «135081 · по графику», and no event is raised.<br>• Held: «обновляется».<br>• Lost: «ТС пропало (нет данных > 5 мин)».<br>• SLA stays frozen after the run ends.<br>The violet GPS-fault mark appears in the legend; the marking flow itself was **не проверено**. |
| REQ-14 §V5 lifecycle ×5 | Snooze return about 24 s later, then close with a reason | — | BLOCKED | **не проверено**: time budget. |

## Findings

**P1: fixed in 89e35cb.** On 4a8b059, `dashboard/app.js:1359` calls `Q.pinFor(..., shown)`. Inside `renderEvents`, the local `const shown = key => …` at line 1381 shadows the route-scope `shown` (line 165), so the call hits the temporal dead zone. As a result, every render with an event open throws. The queue stops rendering, and `aria-current` and the «в работе» pin are lost.
- Repro: open any event, and pageerror fires on every tick.
- On 89e35cb, pageerror = 0 and all queue checks pass.

**P2: the attention text is cut off at 1366 when the card is open.**
- Expected: the whole line «Открыто: ТС 134040 · других событий, требующих реакции, нет» is readable.
- Actual: `.attention-text` has sw 460 and cw 311, is `white-space: nowrap`, and has no ellipsis. It shows «…других событий, требующ».
- Repro: with the `states.mjs` fixture (1 event) at 1366×768, open the event.
- Suspected: `dashboard/style.css:240` (nowrap) combined with the `max-width` at `style.css:212`.
- Evidence: `89e35cb/1366-attention-open.png` and `1366-v1-grayscale.png`.

**P3 findings**
1. At 1366 the rows in the expanded «Завершены» group wrap badly. «ТС / 900104» breaks across two lines and the meta runs to three lines (rows up to 127 px). They are not clipped, but they are cramped. See `89e35cb/1366-ended-expanded-bottom.png`. Look at the event-row grid for ended rows in `dashboard/style.css`.
2. At 1366, queue meta wraps «07:53 → / 08:02» onto two lines. See `1366-02-open-third.png`.
3. At 1920 the header run strip is truncated with an ellipsis: «Официальный эмулятор NDTP → …», «×5 · 1 мин на экране = 5 мин данн…» and «снимок 0 с наз…». Seen on 4a8b059 (`1920-02-open-third.png`) and not re-checked on 89e35cb.
4. When the route context fails validation, the card says «Маршрутный контекст недоступен: HTTP 200». HTTP 200 as the stated reason is misleading. It was triggered by a fixture alias, so it is an artefact, but the wording should name the real cause.
5. Known and accepted: at 1366, closing the card with «Следить» on re-centres the followed vehicle by about 189 px.

## Commands

```
npm --prefix <wt-qa>/dashboard run build && npm --prefix <wt-qa>/dashboard test
/Users/ravius/projects/transport2/.venv/bin/python -m pytest -q tests
node qa/run.mjs <wt-qa> 1920 1080 qa/{main,states,v1,ended,att}.mjs <out>   # and 1366 768
```

## Дополнение координатора (22:12 МСК)

- P1 (`shown` на 4a8b059) исправлен в 89e35cb и перепроверен QA.
- P2 (обрезка полосы внимания на 1366) и P3 (переносы интервала времени и «ТС id») исправлены в 3eec8d0 → main PR #2.
- Сбой живой проверки «legend with a selection ≤ 84 px» (найден на main) исправлен в bccd33c → PR #2; browser-check на этой сборке: live 59/59, regression 140/140, 0 failures.
- Итог: открытых P1/P2 нет; вердикт QA остаётся FINDINGS из-за непроверенных пунктов (V5 время возврата отсрочки, focus-visible, точность pan/zoom после закрытия, toasts под фильтром T-14). Задачи T-15…T-19 — в статусе review до их проверки.
