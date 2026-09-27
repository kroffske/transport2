// Browser check of the served dispatcher screen (consumer + built bundle + real PMTiles), 1920×1080 only.
//
// Two kinds of passes, reported separately:
//   live:       no interception. Everything comes from the stack at UI_URL through real requests
//               (/api/snapshot, /api/route, /api/build). Expected values are read from the same API,
//               so the pass holds for any run, speed-up and data. This is the evidence pass.
//   regression: /api/snapshot and /api/route are replaced by fixed payloads (page.route) to force
//               states a live run does not produce on demand: waiting driver, run ID change, short
//               nodata gap, model failure codes, bad coordinates, Backend offline, missing tiles.
//               Regression results are never evidence of the live chain.
// UI_EVIDENCE_DIR saves 1920×1080 screenshots; UI_LIVE_EVENT_WAIT_S waits that long for a real alert
// to walk the M1 path on live data (otherwise that part is reported as skipped, not passed).
import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {LOST_AFTER_S} from './incidents.js';
import {reasonText} from './reasons.js';
import {coordOk, shiftedText} from './route-context.js';
import {speedupText} from './run.js';

const base = process.env.UI_URL || 'http://127.0.0.1:18882';
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const liveEventWaitS = Number(process.env.UI_LIVE_EVENT_WAIT_S || 0);
const VIEWPORT = {width: 1920, height: 1080};
const failures = [];
const passed = {live: [], regression: []};
const skipped = [];
const liveSelected = {}; // identity of the model result of the vehicle opened in the live pass
let pass = 'live';
const check = (condition, label) => { (condition ? passed[pass] : failures).push(condition ? label : `${pass}: ${label}`); };
if (evidenceDir) fs.mkdirSync(evidenceDir, {recursive: true});
const shot = async (page, name) => { if (evidenceDir) await page.screenshot({path: path.join(evidenceDir, name)}); };

const browser = await chromium.launch({headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader']});
// `allow` exempts expected error answers (e.g. a provoked 404 of /api/route) by URL; `allowErrors` exempts all.
async function open({allowErrors = false, allow = null, setup, context: contextOptions, query = ''} = {}) {
  const expected = url => allowErrors || Boolean(allow && url && allow.test(url));
  const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1, ...contextOptions});
  const page = await context.newPage();
  page.on('pageerror', e => failures.push(`${pass}: pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !expected(m.location()?.url)) failures.push(`${pass}: console: ${m.text()}`); });
  page.on('request', req => { if (!req.url().startsWith(base) && !/^(data|blob):/.test(req.url())) failures.push(`${pass}: external request: ${req.url()}`); });
  // An error status (e.g. the browser's automatic /favicon.ico) is a failure unless the pass provokes errors on purpose.
  page.on('response', res => { if (res.status() >= 400 && !expected(res.url())) failures.push(`${pass}: HTTP ${res.status()}: ${res.url()}`); });
  if (setup) await setup(page);
  await page.goto(`${base}/${query}`, {waitUntil: 'domcontentloaded', timeout: 30000});
  return page;
}
const inside = (box, area) => box && box.x >= area.x - 1 && box.y >= area.y - 1
  && box.x + box.width <= area.x + area.width + 1 && box.y + box.height <= area.y + area.height + 1;
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
// Every pair of visible map labels (vehicles and stop times) that intersect, as «A/B».
const labelOverlaps = page => page.locator('.vehicle-label, .stop-label:not([hidden])').evaluateAll(elements => {
  const boxes = elements.map(el => ({id: el.dataset.id || `stop:${el.dataset.kind}`, r: el.getBoundingClientRect()}));
  const found = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].r, b = boxes[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0) found.push(`${boxes[i].id}/${boxes[j].id}`);
    }
  }
  return found;
});
const rows = page => page.locator('#vehicles .vehicle');
const cardTitle = page => page.locator('#card h2').textContent();
const cardText = page => page.locator('#card').textContent();
const incidentText = page => page.locator('#card .incident').textContent();
const api = (page, url) => page.evaluate(async u => { const r = await fetch(u, {cache: 'no-store'}); return {status: r.status, body: await r.json().catch(() => null)}; }, url);
// A control is usable when the element at its centre is the control itself (nothing drawn over it).
const uncovered = (page, selector) => page.locator(selector).first().evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return r.width > 0 && (hit === el || el.contains(hit));
});
// DOM stability across polls (dom.js): a row or button node under the pointer must survive the
// 1.5 s poll, and a real press that spans a poll must still be a click.
const POLL_SPAN_MS = 1800;
async function survivesPolls(page, selector, label) {
  const handle = await page.locator(selector).first().elementHandle();
  await page.waitForTimeout(2 * POLL_SPAN_MS); // at least two polls
  check(handle && await handle.evaluate(node => node.isConnected), `${label}: the same DOM node survives ≥ 2 polls`);
}
async function pressAcrossPoll(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(POLL_SPAN_MS); // a poll re-renders the panels between down and up
  await page.mouse.up();
  await page.waitForTimeout(300);
}

// Map symbols (map-symbols.js shapeOf): kind|size|border|badge|ring on each vehicle label.
const symbolsOnMap = page => page.locator('.vehicle-label').evaluateAll(labels => labels.map(l => ({id: l.dataset.id, level: l.dataset.level, symbol: l.dataset.symbol ?? ''})));
function symbolMatchesLevel({level, symbol}) {
  const [kind, , border, badge] = symbol.split('|');
  if (kind !== 'vehicle') return false;
  if (badge === '?') return true; // invalid GPS: grey with «?» whatever the level
  return level === 'nodata' ? border === 'dashed' && badge === ''
    : border === 'solid' && badge === ({severe: '!!', warning: '!', normal: ''})[level];
}

const noScenario = async page => await page.locator('#scenario, #mode-badge, [data-mode], .mode-switch, .direction-chip, #routes, [id^=scenario-]').count() === 0
  && !/сценари|Демо-|mode=demo/i.test(await page.locator('body').textContent());

// M1 dispatcher path on the incident of the given vehicle: event centre → card → take into work →
// note (HTML not executed) → return to new → history.
async function dispatcherPath(page, label) {
  await page.locator('#events-toggle').click();
  const events = page.locator('#events-list .event');
  check(await events.count() >= 1, `${label}: event centre lists the event`);
  const eventId = await events.first().getAttribute('data-id');
  await events.first().click();
  await page.waitForTimeout(900);
  check(await page.locator('#events-panel').isHidden() && await page.locator(`.toast[data-id="${eventId}"]`).count() === 0, `${label}: opening the event closes the panel and its toast`);
  check(await page.locator('#card .incident').getAttribute('data-id') === eventId, `${label}: event → its vehicle's card with the same event`);
  check(await page.locator('#incident-action').textContent() === 'Взять в работу', `${label}: primary action is «Взять в работу»`);
  await page.locator('#incident-action').click();
  check(await page.locator('#card .incident-flow').textContent() === 'В работе' && (await incidentText(page)).includes('Взято в работу'), `${label}: acknowledge changes the dispatcher status`);
  const hostile = '<img src=x onerror="window.__xss=1"><b>жирный</b> позвонить водителю';
  await page.locator('#note-input').fill(hostile);
  await page.locator('.note-form button').click();
  const notes = page.locator('.incident-history li[data-kind=note]');
  check(await notes.count() === 1 && (await notes.textContent()).includes(hostile) && await page.locator('#card .incident img, #card .incident-history b').count() === 0
    && await page.evaluate(() => window.__xss === undefined), `${label}: note shown as plain text; HTML not executed`);
  await page.locator('#incident-action').click();
  check(await page.locator('#card .incident-flow').textContent() === 'Новое' && (await incidentText(page)).includes('Возвращено в новые'), `${label}: «Вернуть в новые» reopens`);
  const kinds = await page.locator('.incident-history li').evaluateAll(items => items.map(i => i.dataset.kind));
  check(kinds.filter(k => k === 'action').length === 2 && kinds.includes('note') && kinds.includes('lifecycle'), `${label}: history keeps lifecycle, both actions and the note`);
  return eventId;
}

try {
  // ============================== LIVE: no interception ==============================
  pass = 'live';
  {
    const page = await open();
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForFunction(() => document.getElementById('data-status').dataset.status === 'online', null, {timeout: 15000});
    await page.waitForTimeout(1500);
    const {body: envelope} = await api(page, '/api/snapshot');
    const run = envelope?.snapshot?.run;
    check(envelope?.status === 'online' && run && typeof run === 'object', 'snapshot is online and carries `run`');
    await page.waitForTimeout(1600); // one more poll so the header shows at least this snapshot
    check(await page.locator('#run-speed').textContent() === speedupText(run?.speedup) && await page.locator('#run-speed').getAttribute('data-speedup') === String(run?.speedup ?? ''),
      `header speed-up equals snapshot.run.speedup (${await page.locator('#run-speed').textContent()})`);
    check(await page.locator('#run-id').getAttribute('data-run-id') === (run?.run_id ?? ''), `header run ID equals snapshot.run.run_id (${run?.run_id})`);
    // The live pass is evidence of the official emulator chain only: any other source fails it.
    check(run?.source === 'official_emulator' && typeof run?.run_id === 'string' && run.run_id.length > 0
      && ['starting', 'running', 'completed'].includes(run?.state),
    `live run is the official emulator with a run_id (source ${run?.source}, run_id ${run?.run_id}, state ${run?.state})`);
    check((await page.locator('#run-source').textContent()).includes('Официальный эмулятор NDTP'), 'header names the official emulator as the source');
    check(await page.locator('#run').getAttribute('data-state') === (run?.state ?? 'unknown') && (await page.locator('#run-state').textContent()).length > 0, `header lifecycle is snapshot.run.state (${run?.state})`);
    check(await noScenario(page), 'no scenario, mode switch or direction catalogue on the page');
    check((await page.locator('link[rel=icon]').getAttribute('href')).startsWith('data:image/svg+xml,'), 'inline page icon, no /favicon.ico request');
    const vehicles = envelope?.snapshot?.vehicles ?? [];
    check(await rows(page).count() === vehicles.length, `list shows the ${vehicles.length} vehicles of the run`);
    // Stable DOM on live polls: rows and the banner button stay the same nodes; a slow real click works.
    if (vehicles.length >= 2) {
      await survivesPolls(page, '#vehicles .vehicle', 'live list row');
      if (await page.locator('#attention button').count()) await survivesPolls(page, '#attention button', 'live «Открыть карточку»');
      else skipped.push('live: no warning banner button at this moment — its node check runs in regression only');
      const pick = await page.locator('#vehicles .vehicle').nth(1).getAttribute('data-id');
      await pressAcrossPoll(page, `#vehicles .vehicle[data-id="${pick}"]`);
      check(await cardTitle(page) === pick && await page.locator(`#vehicles .vehicle[data-id="${pick}"]`).getAttribute('aria-current') === 'true',
        `live: mouse down → poll → up on row ${pick} selects it`);
      await page.locator('#card-close').click();
    } else skipped.push('live: fewer than 2 vehicles — DOM stability checks run in regression only');
    await page.locator('#overview').click();
    await page.waitForTimeout(1200);
    const overlapsOverview = await labelOverlaps(page);
    check(overlapsOverview.length === 0, `overview: no two map labels intersect (${overlapsOverview.join(', ') || 'none'})`);
    await shot(page, 'live-1-overview-1920.png');
    const drawn = await symbolsOnMap(page);
    check(drawn.length > 0 && drawn.every(symbolMatchesLevel), `map symbols: every vehicle is a bus icon whose non-colour marks match its state (${drawn.map(d => `${d.id}:${d.symbol}`).join(', ')})`);
    const legend = await page.locator('img.legend-symbol').evaluateAll(images => images.map(img => img.src));
    check(legend.length === 7 && new Set(legend).size === 7 && legend.every(src => src.startsWith('data:image/png')), 'legend shows the 7 map symbols, all different, drawn locally');
    const legendBox = await page.locator('.legend').boundingBox();
    check(legendBox.height <= 56 && legendBox.width <= 720 && await page.locator('#legend-route').isHidden()
      && (await page.locator('#legend-help').getAttribute('title')).includes('Цвет ТС'), `legend without a selection: one row ≤ 56 px, route row hidden, note in «?» (${Math.round(legendBox.width)}×${Math.round(legendBox.height)})`);

    // A vehicle with a current model prediction, a target and a valid position.
    const candidate = vehicles.filter(v => v.status === 'normal' && v.prediction_s != null && v.target_stop_id && v.location_valid)
      .sort((a, b) => Number(b.prediction_s) - Number(a.prediction_s))[0];
    if (!candidate) skipped.push('live: no vehicle with a current prediction in this snapshot — route/card checks not run');
    else {
      const id = String(candidate.tr_id);
      Object.assign(liveSelected, {tr_id: id, model_version: candidate.model_version ?? null, artifact_sha256: candidate.artifact_sha256 ?? null});
      await page.locator(`#vehicles .vehicle[data-id="${id}"]`).click();
      await page.waitForFunction(() => ['ok', 'missing', 'offline'].includes(document.getElementById('route')?.dataset.status), null, {timeout: 10000});
      await page.waitForTimeout(1500);
      const {status: routeStatus, body: routeBody} = await api(page, `/api/route/${encodeURIComponent(id)}`);
      check(routeStatus === 200 && Array.isArray(routeBody?.stops), `/api/route/${id} answers with stops`);
      check(await page.locator('#route').getAttribute('data-status') === 'ok', `route context of ${id} loaded`);
      const text = await cardText(page);
      check(text.includes('Текущее опоздание') && text.includes('(факт)'), 'card: current delay labelled as fact');
      const roles = (routeBody?.stops ?? []).map(s => s.role);
      const target = (routeBody?.stops ?? []).find(s => s.role === 'target');
      if (target) {
        const targetRow = page.locator('.stops li[data-role=target]');
        const expected = routeBody.prediction_s != null ? shiftedText(target.time, routeBody.prediction_s) : null;
        check(await targetRow.count() === 1 && (await targetRow.textContent()).includes('прогноз модели')
          && (!expected || (await targetRow.textContent()).includes(expected)), `card: target = plan + prediction_s «прогноз модели» (${expected})`);
        check(await page.locator('.stop-label[data-kind=target]').count() === 1
          && inside(await page.locator('.stop-label[data-kind=target]').boundingBox(), await page.locator('#map-pane').boundingBox()), 'map: target time label drawn inside the map (never at 0/0)');
      } else skipped.push(`live: route of ${id} has no target stop at this moment`);
      if (roles.includes('before_target') && routeBody.cur_dev_s != null) check((await page.locator('.stops li[data-role=before_target]').first().textContent()).includes('по факту, не прогноз'), 'card: stops before the target = plan + cur_dev_s «по факту, не прогноз»');
      if (roles.includes('passed')) check(!/→/.test(await page.locator('.stops li[data-role=passed]').first().textContent()), 'card: passed stops show the plan time only');
      if (roles.includes('after_target') && routeBody.prediction_s != null) {
        check(await page.locator('#shift-after-target').isChecked() && (await page.locator('.stops li[data-role=after_target]').first().textContent()).includes('допущение: тот же сдвиг'), 'card: after the target «допущение: тот же сдвиг», toggle on by default');
        await page.locator('#shift-after-target').uncheck();
        check(!(await page.locator('.stops').textContent()).includes('допущение') && (await page.locator('.stops li[data-role=target]').textContent()).includes('прогноз модели'), 'card: toggle off hides the assumption, keeps the model value');
        await page.locator('#shift-after-target').check();
      }
      check((await page.locator('#route .route-caption').textContent()).includes('не официальная трасса'), 'card: the grey line is named «путь по GPS прогона», not an official route');
      check((await page.locator('#legend-route').textContent()).includes('путь по GPS прогона') && (await page.locator('.legend').boundingBox()).height <= 84, 'legend with a selection: route row shown, ≤ 84 px');
      check(await page.locator('.stop-label').count() <= 2, 'map: time labels only for the target and the nearest future stop');
      const overlapsSelected = await labelOverlaps(page);
      check(overlapsSelected.length === 0, `selected: no two map labels intersect (${overlapsSelected.join(', ') || 'none'})`);
      check(inside(await page.locator('.vehicle-label.is-selected').boundingBox(), await page.locator('#map-pane').boundingBox()), 'selected vehicle inside the map, not under a panel');
      for (const selector of ['#events-toggle', '#diagnostics summary', '#overview', '#card-show', '#card-close', '#shift-after-target']) {
        check(await uncovered(page, selector), `${selector} is not covered at 1920×1080`);
      }
      await shot(page, 'live-2-selected-route-1920.png');
      // Evidence view: the stop list with the toggle, the target and the stops after it.
      await page.locator('#card').evaluate(card => {
        const box = card.querySelector('#route');
        card.scrollTop += box.getBoundingClientRect().top - card.getBoundingClientRect().top - 8;
        const list = box.querySelector('.stops');
        const target = list?.querySelector('li[data-role=target]');
        if (target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 66;
      });
      await shot(page, 'live-3-card-fact-forecast-assumption-1920.png');
    }

    // A vehicle without a current prediction: honest reason, not a green state.
    const without = vehicles.find(v => v.status !== 'normal' && v.location_valid) ?? vehicles.find(v => v.status !== 'normal');
    if (without) {
      await page.locator(`#vehicles .vehicle[data-id="${without.tr_id}"]`).click();
      await page.waitForTimeout(1500);
      const text = await cardText(page);
      check(await page.locator('#card').getAttribute('data-level') === 'nodata' && (text.includes('Прогноза нет') || text.includes('устарел'))
        && (!without.reason || text.includes(reasonText(without.reason))), `no prediction (${without.reason}): «${reasonText(without.reason)}», not green`);
      await shot(page, 'live-4-no-prediction-1920.png');
    } else skipped.push('live: every vehicle has a current prediction — no-prediction card not shown');
    // Live rows change: take the invalid-GPS vehicle from a fresh snapshot and check the card against the row it shows.
    const invalid = ((await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? []).find(v => !v.location_valid);
    if (invalid) {
      await page.locator(`#vehicles .vehicle[data-id="${invalid.tr_id}"]`).click();
      await page.waitForTimeout(900);
      const row = ((await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? []).find(v => String(v.tr_id) === String(invalid.tr_id));
      if (row && !row.location_valid && coordOk(row.lon, row.lat)) {
        // lon/lat is the last valid position: drawn grey with «?», the card says so.
        check(await cardTitle(page) === String(invalid.tr_id) && (await cardText(page)).includes('Последний кадр без валидного GPS')
          && (await page.locator(`.vehicle-label[data-id="${invalid.tr_id}"]`).getAttribute('data-symbol'))?.includes('|?|'),
        'invalid GPS: drawn at the last valid position with «?», card says so');
        await shot(page, 'live-5-invalid-gps-1920.png');
      } else if (row && !row.location_valid) {
        check(await cardTitle(page) === String(invalid.tr_id) && (await cardText(page)).includes('объект на карте не показан') && await page.locator('#card-show').isDisabled()
          && await page.locator(`.vehicle-label[data-id="${invalid.tr_id}"]`).count() === 0, 'invalid GPS without a valid position: listed, not drawn, card says so');
      } else skipped.push(`live: ${invalid.tr_id} got a valid GPS fix during the check — invalid-GPS card not asserted`);
    } else skipped.push('live: no vehicle with invalid GPS in this snapshot');

    // Diagnostics: full build identity exactly as /api/build reports it, and the run's thinning.
    const {body: build} = await api(page, '/api/build');
    await page.locator('#card-close').click().catch(() => {});
    await page.locator('#diagnostics summary').click();
    await page.waitForTimeout(1200);
    const diag = await page.locator('#diag-list').textContent();
    const identity = ['source_commit', 'dashboard_bundle_sha256', 'consumer_static_sha256'];
    check(identity.every(key => typeof build?.[key] === 'string' && diag.includes(build[key])), `diagnostics show ${identity.join(', ')} from /api/build`);
    check(Object.entries(build?.files ?? {}).length > 0 && Object.entries(build.files).every(([name, hash]) => diag.includes(name) && diag.includes(hash)), 'diagnostics keep the per-file hashes (/api/build files)');
    check(diag.includes('thinned_ratio') && diag.includes('repeat_ratio') && diag.includes(String(run?.run_id ?? 'неизвестно')), 'diagnostics show run ID, thinned_ratio and repeat_ratio');
    await shot(page, 'live-6-diagnostics-1920.png');
    await page.locator('#diagnostics summary').click();

    // M1 on live data needs a real alert (> 2 min); it is waited for, never faked.
    const deadline = Date.now() + liveEventWaitS * 1000;
    while (await page.locator('#events-toggle').getAttribute('data-active') === '0' && Date.now() < deadline) await page.waitForTimeout(1500);
    if (await page.locator('#events-toggle').getAttribute('data-active') !== '0') {
      await dispatcherPath(page, 'M1 live');
      await shot(page, 'live-7-m1-event-card-1920.png');
    } else skipped.push(`live: no real alert within ${liveEventWaitS} s — M1 path on live data not walked (see regression M1)`);
    await page.close();
  }

  // ============================== REGRESSION: fixed payloads ==============================
  pass = 'regression';
  const RUN = (run_id, extra = {}) => ({run_id, state: 'running', source: 'official_emulator', speedup: 7, post_period_s: 1,
    dataset_start: '2026-01-06T06:30:00', dataset_end: '2026-01-06T08:30:00', dataset_time: '2026-01-06T06:47:10',
    progress: 0.14, thinned_ratio: 0.12, repeat_ratio: 0.03, vehicle_count: 2, accepted_frames: 120, last_frame_age_s: 0.7,
    registered_at_utc: '2026-09-27T12:00:00', driver: {state: 'running', reason: null, counters: {}, reported_at_utc: '2026-09-27T12:00:05'}, ...extra});
  const bus = (tr_id, lon, lat, extra = {}) => ({tr_id, unit_id: 1, lon, lat, location_valid: true, gps_age_s: 4, connected: true,
    status: 'normal', reason: null, target_stop_id: `T${tr_id}`, target_time_begin: '2026-01-06T06:58:00',
    target_lon: lon + 0.012, target_lat: lat + 0.004, cur_dev_s: 95, prediction_s: 90, prediction_updating: false,
    prediction_age_s: 20, model_version: 'regression-model', artifact_sha256: 'regression-artifact',
    prediction_input_frame_id: `r:${tr_id}`, prediction_context_revision: 3, last_success_at: '2026-01-06T06:46:50', revision: 5, ...extra});
  // Shape of consumer /api/route (status wrapper) around Backend /v1/route (transport_backend/orchestration.py).
  const routeOf = (v, extra = {}) => ({status: 'online', reason: null, run_id: state.snapshot.run.run_id, tr_id: v.tr_id, unit_id: 1,
    vehicle_revision: v.revision, clock_time: '2026-01-06T06:47:10', window_start: '2026-01-06T06:42:10', window_end: '2026-01-06T07:13:00',
    stops_truncated: 0, target_time_begin: v.target_time_begin, prediction_updating: v.prediction_updating,
    path: [[v.lon - 0.01, v.lat - 0.004], [v.lon, v.lat], [v.target_lon, v.target_lat], [v.target_lon + 0.01, v.target_lat + 0.004]],
    passed: [[v.lon - 0.01, v.lat - 0.004, '06:40:00'], [v.lon, v.lat, '06:47:05']],
    stops: [{stop_id: 'P1', time: '06:44:00', lon: v.lon - 0.006, lat: v.lat - 0.0025, role: 'passed'},
      {stop_id: 'B1', time: '06:52:00', lon: v.lon + 0.005, lat: v.lat + 0.0017, role: 'before_target'},
      {stop_id: v.target_stop_id, time: '06:58:00', lon: v.target_lon, lat: v.target_lat, role: 'target'},
      {stop_id: 'A1', time: '07:03:00', lon: v.target_lon + 0.006, lat: v.target_lat + 0.002, role: 'after_target'}],
    stops_dropped: 0, target_stop_id: v.target_stop_id, cur_dev_s: v.cur_dev_s, prediction_s: v.prediction_s,
    model_version: v.model_version, artifact_sha256: v.artifact_sha256, ...extra});
  const state = {status: 'online', snapshot: null, route: {}};
  const setSnapshot = (run, vehicles, sourceClock = 'simulation') => { state.status = 'online'; state.snapshot = {schema_version: 'transport.backend-vehicles.v1', revision: 1,
    source_clock: sourceClock, clock_time: run?.dataset_time ?? '2026-01-06T06:47:10', run, vehicles}; };
  const setup = page => Promise.all([
    page.route('**/api/snapshot', route => route.fulfill({contentType: 'application/json', body: JSON.stringify(state.status === 'online'
      ? {status: 'online', reason: null, age_s: 0, fetched_at: '2026-09-27T12:00:00Z', checked_at: '2026-09-27T12:00:00Z', snapshot: state.snapshot}
      : {status: 'offline', reason: 'Backend HTTP 503', age_s: 9, fetched_at: '2026-09-27T12:00:00Z', checked_at: '2026-09-27T12:00:09Z', snapshot: state.snapshot})})),
    page.route('**/api/route/*', route => {
      const id = decodeURIComponent(route.request().url().split('/').pop());
      const answer = state.route[id];
      // Same statuses as consumer/service.py RouteReader: 404 not_found, 503 offline.
      if (answer === 404 || answer === undefined) return route.fulfill({status: 404, contentType: 'application/json', body: '{"status":"not_found","reason":"unknown_tr_id"}'});
      if (answer === 'offline') return route.fulfill({status: 503, contentType: 'application/json', body: '{"status":"offline","reason":"Backend HTTP 503"}'});
      return route.fulfill({contentType: 'application/json', body: JSON.stringify(answer)});
    }),
  ]);
  const center = [37.6173, 55.7558];
  {
    // Waiting for the driver → run registered: header, list and speed-up follow snapshot.run.
    setSnapshot({run_id: null, state: 'waiting_driver', source: 'official_emulator', speedup: null, progress: null, thinned_ratio: null, repeat_ratio: null,
      vehicle_count: 0, accepted_frames: 0, last_frame_age_s: null, registered_at_utc: null, driver: null}, []);
    const page = await open({setup, allow: /\/api\/route\//});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForFunction(() => document.getElementById('run').dataset.state === 'waiting_driver', null, {timeout: 8000});
    check((await page.locator('#run-state').textContent()).includes('ожидание драйвера эмулятора') && (await page.locator('#run-id').textContent()).includes('не зарегистрирован')
      && (await page.locator('#vehicles').textContent()).includes('ждёт регистрации драйвера'), 'waiting_driver: header and list say the run has not started');
    await page.locator('#diagnostics summary').click();
    check((await page.locator('#diag-list').textContent()).includes('Прореживание (thinned_ratio)— точек окна'), 'thinned_ratio null before the first driver heartbeat is shown as «—»');
    await shot(page, 'regression-1-waiting-driver-1920.png');
    await page.locator('#diagnostics summary').click();

    const a = bus('900001', center[0], center[1], {prediction_s: 200});
    const b = bus('900002', center[0] + 0.03, center[1] + 0.01, {prediction_s: 40, prediction_updating: true, prediction_age_s: 35});
    // Valid GPS outside the data extent (tiles and Backend MAP_BBOX 37.25–38.00): listed, not drawn.
    const out = bus('900009', 37.1, 55.7, {prediction_s: 30});
    setSnapshot(RUN('run-A-0001'), [a, b, out]);
    state.route = {900001: routeOf(a), 900002: routeOf(b)};
    await page.waitForFunction(() => document.getElementById('run').dataset.state === 'running', null, {timeout: 8000});
    check(await page.locator('#run-speed').textContent() === 'Ускорение ×7: 1 мин показа = 7 мин данных', 'speed-up ×7 from the run, not a fixed ×5');
    check((await page.locator('#run-state').textContent()) === 'идёт · 14 %' && (await page.locator('#run-clock').textContent()).includes('06:47:10'), 'lifecycle, progress and data time from the run');
    check(await page.locator('#events-unread').textContent() === '1' && await page.locator('.toast').count() === 0, 'first snapshot of a run: existing warning counted, no toast');
    check((await page.locator('#vehicles .vehicle[data-id="900009"]').textContent()).includes('вне карты')
      && await page.locator('.vehicle-label[data-id="900009"]').count() === 0, 'valid GPS outside the data extent: listed «вне карты», not drawn');
    await survivesPolls(page, '#vehicles .vehicle[data-id="900002"]', 'list row');
    await survivesPolls(page, '#attention button', '«Открыть карточку»');
    await pressAcrossPoll(page, '#vehicles .vehicle[data-id="900002"]');
    check(await cardTitle(page) === '900002', 'mouse down → poll → up on a list row selects the vehicle');
    await page.locator('#card-close').click();
    await pressAcrossPoll(page, '#attention button');
    check(await cardTitle(page) === '900001', 'mouse down → poll → up on «Открыть карточку» opens the card');
    await survivesPolls(page, '#card-close', 'card close button');
    await page.locator('#shift-after-target').focus();
    await page.waitForTimeout(POLL_SPAN_MS);
    check(await page.evaluate(() => document.activeElement?.id) === 'shift-after-target', 'the toggle keeps keyboard focus across a poll');
    await page.locator('#card-close').click();
    setSnapshot(RUN('run-A-0001'), [a, b]);
    await page.waitForTimeout(POLL_SPAN_MS);

    // prediction_updating: still the normal level, with the «обновляется» badge and age.
    await page.locator('#vehicles .vehicle[data-id="900002"]').click();
    await page.waitForTimeout(700);
    check(await page.locator('#card').getAttribute('data-level') === 'normal' && (await page.locator('#prediction-updating').textContent()).includes('обновляется')
      && (await page.locator('#prediction-updating').textContent()).includes('35 с'), 'prediction_updating: normal level, badge «обновляется» with age');

    // M1 on fixed data: event → card → take into work → note → reopen → history.
    await dispatcherPath(page, 'M1 regression');
    await shot(page, 'regression-2-m1-card-1920.png');

    // Short nodata (a new target's prediction pending) shorter than LOST_AFTER_S: nothing changes.
    const historyBefore = await page.locator('.incident-history li').count();
    await page.locator('#card-close').click();
    setSnapshot(RUN('run-A-0001'), [{...a, status: 'degraded', reason: 'prediction_pending', prediction_s: null}, b]);
    await page.waitForTimeout(Math.max(3000, (LOST_AFTER_S - 8) * 1000));
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    check(await page.locator('#card .incident').getAttribute('data-state') === 'active' && await page.locator('.incident-history li').count() === historyBefore
      && await page.locator('#events-unread').isHidden(), `nodata shorter than ${LOST_AFTER_S} s: still «Активно», no history line, no unread`);
    check((await cardText(page)).includes('Прогноза нет: прогноз обновляется для новой цели'), 'prediction_pending: honest «прогноз обновляется для новой цели»');
    await page.waitForTimeout((LOST_AFTER_S - 4) * 1000);
    check(await page.locator('#card .incident').getAttribute('data-state') === 'monitoring_lost', `nodata for ≥ ${LOST_AFTER_S} s: «Мониторинг потерян»`);
    setSnapshot(RUN('run-A-0001'), [a, b]);
    await page.waitForTimeout(2000);

    // Route context: fact / model / assumption; bad coordinates never drawn; 404 and offline honest.
    state.route['900001'] = routeOf(a, {path: [[center[0], center[1]], [0, 0], [center[0] + 0.01, center[1]]],
      stops: [...routeOf(a).stops, {stop_id: 'Z0', time: '07:05:00', lon: 0, lat: 0, role: 'after_target'},
        {stop_id: 'ZN', time: '07:06:00', lon: null, lat: null, role: 'after_target'}], stops_dropped: 2});
    await page.locator('#vehicles .vehicle[data-id="900002"]').click();
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'ok', null, {timeout: 8000});
    const stops = page.locator('.stops li');
    check((await stops.nth(0).textContent()).startsWith('06:44') && (await stops.nth(0).textContent()).includes('пройдена'), 'passed stop: plan time only');
    check((await stops.nth(1).textContent()).includes('06:52 → ~06:53:35') && (await stops.nth(1).textContent()).includes('по факту, не прогноз'), 'before target: plan + cur_dev_s «по факту, не прогноз»');
    check((await stops.nth(2).textContent()).includes('06:58 → ~07:01:20') && (await stops.nth(2).textContent()).includes('прогноз модели'), 'target: plan + prediction_s «прогноз модели»');
    check((await stops.nth(3).textContent()).includes('07:03 → ~07:06:20') && (await stops.nth(3).textContent()).includes('допущение: тот же сдвиг'), 'after target: «допущение: тот же сдвиг»');
    check(await page.locator('.stops li[data-stop=Z0]').getAttribute('title') === 'Координаты нет — на карте не показана'
      && await page.locator('.stops li[data-stop=ZN]').getAttribute('title') === 'Координаты нет — на карте не показана'
      && (await page.locator('#route').textContent()).includes('2 остановок без координат на карте не показаны')
      && (await page.locator('#route').textContent()).includes('2 остановок без координат исключены Backend'), 'stops at 0/0 or without coordinates are listed but not drawn, and counted');
    check(await page.locator('.stop-label').count() === 2 && (await page.locator('.stop-label[data-kind=target]').textContent()).includes('~07:01:20')
      && (await page.locator('.stop-label[data-kind=next]').textContent()).includes('~06:53:35'), 'map labels: target and nearest future stop only');
    const pane = await page.locator('#map-pane').boundingBox();
    for (const kind of ['target', 'next']) check(inside(await page.locator(`.stop-label[data-kind=${kind}]`).boundingBox(), pane), `map label ${kind} inside the map`);
    await page.locator('#shift-after-target').uncheck();
    check((await stops.nth(3).textContent()).includes('07:03') && !(await stops.nth(3).textContent()).includes('~'), 'toggle off: after-target stops show plan time only');
    await page.locator('#shift-after-target').check();
    await shot(page, 'regression-3-route-bad-coords-1920.png');
    // A degraded row keeps a numeric prediction: it is not shown as the model's value or its assumption.
    setSnapshot(RUN('run-A-0001'), [{...a, status: 'degraded', reason: 'prediction_pending'}, b]);
    await page.waitForFunction(() => document.getElementById('card').dataset.level === 'nodata', null, {timeout: 6000});
    await page.waitForTimeout(300);
    const degraded = await page.locator('.stops').textContent();
    check(!degraded.includes('прогноз модели') && !degraded.includes('допущение') && (await page.locator('.stops li[data-role=target]').textContent()).includes('прогноз устарел')
      && !(await page.locator('.stop-label[data-kind=target]').textContent()).includes('прогноз модели'),
    'degraded row with a numeric prediction_s: no «прогноз модели», no «допущение» on stops or map');
    await shot(page, 'regression-3b-degraded-stale-prediction-1920.png');
    setSnapshot(RUN('run-A-0001'), [a, b]);
    await page.waitForFunction(() => document.getElementById('card').dataset.level !== 'nodata', null, {timeout: 6000});
    state.route['900001'] = 'offline';
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'offline', null, {timeout: 8000});
    check((await page.locator('#route').textContent()).includes('Backend не отвечает') && await page.locator('.stops li').count() > 0, 'route offline: last context kept and marked as not updating');
    state.route['900002'] = 404;
    await page.locator('#vehicles .vehicle[data-id="900002"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'missing', null, {timeout: 8000});
    check((await page.locator('#route').textContent()).includes('Маршрутного контекста нет') && await page.locator('.stops').count() === 0, 'route 404: no invented stops');
    check((await page.locator('#route').textContent()).includes('Backend не знает это ТС в текущем прогоне'), 'route 404 unknown_tr_id: Russian label, not the code');

    // Model failure reasons in Russian, unknown code as is, never a green state.
    const reasons = [['ml_unreachable_or_timeout', 'модель недоступна (нет ответа или timeout)'], ['ml_http_503', 'модель ответила ошибкой HTTP 503'],
      ['no_target_in_horizon', 'у ТС нет плановой остановки через 10–15 мин'], ['brand_new_code', 'brand_new_code']];
    for (const [reason, label] of reasons) {
      setSnapshot(RUN('run-A-0001'), [a, {...b, status: 'unavailable', reason, prediction_s: null, prediction_updating: false}]);
      await page.waitForFunction(r => document.getElementById('card').textContent.includes(r), label, {timeout: 6000}).catch(() => {});
      check((await cardText(page)).includes(`Прогноза нет: ${label}`) && await page.locator('#card').getAttribute('data-level') === 'nodata', `reason ${reason} → «${label}», not green`);
      if (reason === 'ml_unreachable_or_timeout') await shot(page, 'regression-4-ml-unreachable-1920.png');
    }

    // Backend offline: last snapshot, honest status, no substitution.
    state.status = 'offline';
    await page.waitForFunction(() => document.getElementById('data-status').textContent.includes('Backend недоступен · последний снимок'), null, {timeout: 6000});
    check((await page.locator('#attention').textContent()).includes('Backend недоступен') && await page.locator('#run-id').getAttribute('data-run-id') === 'run-A-0001', 'offline: last snapshot kept, run on screen unchanged');
    await shot(page, 'regression-5-backend-offline-1920.png');

    // A new run ID (stack recreated): events, history, selection and route are dropped.
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    setSnapshot(RUN('run-B-0002', {progress: 0.01, dataset_time: '2026-01-06T06:31:00'}), [{...a, prediction_s: 30}, {...b, prediction_s: 20, status: 'normal', reason: null}]);
    state.route = {900001: routeOf(a), 900002: routeOf(b)};
    await page.waitForFunction(() => document.getElementById('run-id').dataset.runId === 'run-B-0002', null, {timeout: 8000});
    await page.waitForTimeout(500);
    await page.locator('#events-toggle').click();
    check(await page.locator('#events-list .event').count() === 0 && await page.locator('#events-unread').isHidden() && await page.locator('#card .card-empty').count() === 1
      && await page.locator('.stop-label').count() === 0 && await page.locator('.toast').count() === 0, 'new run_id: events, history, selection and route context cleared');
    await page.locator('#events-close').click();
    // Outside SOURCE_CLOCK=simulation Backend has no run: said so, no invented run or speed-up.
    setSnapshot(null, [a], 'dataset_wall');
    await page.waitForFunction(() => document.getElementById('run-source').textContent.includes('Backend без прогона'), null, {timeout: 6000});
    check((await page.locator('#run-source').textContent()).includes('часы dataset_wall') && await page.locator('#run-id').textContent() === 'прогона нет'
      && await page.locator('#run-speed').textContent() === 'Ускорение неизвестно', 'snapshot.run = null: no run, no speed-up invented');
    check(await noScenario(page), 'no scenario elements in any state');
    await page.close();
  }

  // Every map symbol state at once: warning, severe, normal, invalid GPS at the last valid
  // position, no current prediction; then the selected vehicle with its stops and target.
  {
    const a = bus('900001', center[0], center[1], {prediction_s: 200});
    const b = bus('900002', center[0] + 0.03, center[1] + 0.01, {prediction_s: 40});
    const gpsBad = bus('900003', center[0] - 0.03, center[1] - 0.012, {prediction_s: 30, location_valid: false});
    const stale = bus('900004', center[0] + 0.02, center[1] - 0.015, {status: 'degraded', reason: 'prediction_pending', prediction_s: null});
    const severe = bus('900005', center[0] - 0.015, center[1] + 0.016, {prediction_s: 420});
    setSnapshot(RUN('run-E-0005'), [a, b, gpsBad, stale, severe]);
    // Dense timetable (a stop every ~100 m) to check that stops are thinned below z13.
    const dense = Array.from({length: 30}, (_, i) => ({stop_id: `D${i}`, time: `06:${String(48 + Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 20).padStart(2, '0')}`,
      lon: center[0] - 0.02 + i * 0.0015, lat: center[1] - 0.006 + i * 0.0004, role: i < 10 ? 'passed' : i < 20 ? 'before_target' : 'after_target'}));
    state.route = {900001: routeOf(a, {stops: [...dense.slice(0, 20), {stop_id: a.target_stop_id, time: '06:58:00', lon: a.target_lon, lat: a.target_lat, role: 'target'}, ...dense.slice(20)]})};
    const page = await open({setup, query: '?debug'});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(2500);
    const symbols = Object.fromEntries((await symbolsOnMap(page)).map(d => [d.id, d.symbol]));
    check(symbols['900001']?.includes('|!|') && symbols['900005']?.includes('|!!|') && symbols['900003']?.includes('|?|')
      && symbols['900004']?.includes('|dashed|') && symbols['900002']?.split('|')[3] === '' && new Set(Object.values(symbols)).size === 5,
    `symbols differ without colour: «!», «!!», «?», dashed, plain (${JSON.stringify(symbols)})`);
    check(await page.locator('.vehicle-label[data-id="900003"]').count() === 1 && (await page.locator('#vehicles .vehicle[data-id="900003"]').textContent()).includes('GPS недостоверен'),
      'invalid GPS with a last valid position: drawn there and marked in the list');
    await shot(page, 'regression-7-symbols-1920.png');
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'ok', null, {timeout: 8000});
    await page.waitForTimeout(800);
    check((await page.locator('.vehicle-label.is-selected').getAttribute('data-symbol'))?.endsWith('|selected'), 'selected vehicle: ring and larger icon');
    const overlaps = await labelOverlaps(page);
    check(overlaps.length === 0, `symbols: no two map labels intersect (${overlaps.join(', ') || 'none'})`);
    await shot(page, 'regression-8-symbols-selected-1920.png');
    // M-2: at z11 and z12 no two drawn stops closer than 12 px; at z14 every stop is drawn.
    for (const zoom of [11, 12, 14]) {
      await page.evaluate(z => window.__map.jumpTo({zoom: z}), zoom);
      await page.waitForTimeout(700);
      const {count, minGap} = await page.evaluate(() => {
        const map = window.__map;
        const points = map.queryRenderedFeatures({layers: ['route-stops']}).map(f => map.project(f.geometry.coordinates));
        let min = Infinity;
        for (let i = 0; i < points.length; i += 1) for (let j = i + 1; j < points.length; j += 1) min = Math.min(min, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
        return {count: points.length, minGap: min};
      });
      if (zoom < 13) check(count > 0 && minGap >= 12, `z${zoom}: ${count} stops drawn, closest pair ${Math.round(minGap)} px ≥ 12`);
      else check(count === 30, `z${zoom}: all 30 stops drawn (${count})`);
      if (zoom === 12) await shot(page, 'regression-9-stops-thinned-z12-1920.png');
    }
    await page.close();
  }

  // Driver-contact prototype: a copy is reported only when it happened; nothing is ever «sent».
  for (const [label, options] of [
    ['clipboard granted', {context: {permissions: ['clipboard-read', 'clipboard-write']}}],
    ['clipboard unavailable', {setup: page => page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'clipboard', {get: () => undefined}); })}],
  ]) {
    const a = bus('900001', center[0], center[1], {prediction_s: 200});
    setSnapshot(RUN('run-C-0003'), [a]);
    state.route = {900001: routeOf(a)};
    const page = await open({...options, setup: async p => { await setup(p); if (options.setup) await options.setup(p); }});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForSelector('#attention button', {timeout: 8000});
    await page.locator('#attention button').click();
    await page.locator('#contact-open').click();
    const draft = await page.locator('#contact-text').inputValue();
    check(draft.includes('900001') && draft.includes('3.3 мин') && await page.locator('#contact-text').getAttribute('readonly') !== null
      && (await page.locator('.contact').textContent()).includes('Прототип · отправка не подключена'), `prototype (${label}): marked preview with a prepared text`);
    await page.locator('#contact-copy').click();
    await page.waitForSelector('#contact-result:not([data-result=none])', {timeout: 3000});
    const result = await page.locator('#contact-result').textContent();
    const card = await cardText(page);
    check(!/отправлено|отправлен водителю|доставлено/i.test(card.replace('ещё не отправлен', '').replace('Ничего не отправлено', '')), `prototype (${label}): never claims a sent message`);
    if (label === 'clipboard granted') {
      check(await page.locator('#contact-result').getAttribute('data-result') === 'copied' && result.includes('скопирован')
        && await page.evaluate(() => navigator.clipboard.readText()) === draft, 'prototype: copy reported only after the text is in the clipboard');
    } else {
      check(await page.locator('#contact-result').getAttribute('data-result') === 'manual' && result.includes('скопируйте его вручную') && !result.includes('Текст скопирован'),
        'prototype: without a clipboard the text is selected for manual copy, no false success');
    }
    await page.close();
  }

  // Map archive missing: explicit error, no points or route drawn over a missing base map.
  {
    const a = bus('900001', center[0], center[1], {prediction_s: 200});
    setSnapshot(RUN('run-D-0004'), [a]);
    state.route = {900001: routeOf(a)};
    const page = await open({allowErrors: true, setup: async p => { await setup(p); await p.route('**/map/moscow.pmtiles', route => route.fulfill({status: 404, body: 'missing'})); }});
    await page.waitForSelector('#map-pane[data-state=unavailable]', {timeout: 15000});
    await page.waitForTimeout(1600);
    check((await page.locator('#map-state').textContent()).includes('Карта недоступна'), 'map-unavailable: explicit message');
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    await page.waitForTimeout(1500);
    check(await cardTitle(page) === '900001' && await page.locator('#card-show').isDisabled() && await page.locator('.vehicle-label, .stop-label').count() === 0,
      'map-unavailable: list and card work, nothing drawn over the missing map');
    await shot(page, 'regression-6-map-unavailable-1920.png');
    await page.close();
  }
} catch (error) {
  failures.push(`${pass}: exception: ${error.message}`);
} finally {
  await browser.close();
}
console.log(JSON.stringify({base, live: {passed: passed.live.length, selected: liveSelected, checks: passed.live}, regression: {passed: passed.regression.length, checks: passed.regression},
  skipped, failures}, null, 1));
if (failures.length) process.exitCode = 1;
