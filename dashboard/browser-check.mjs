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
import {coordOk, routeLayersFor, shiftedText} from './route-context.js';
import {speedupText} from './run.js';

const base = process.env.UI_URL || 'http://127.0.0.1:18882';
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const liveEventWaitS = Number(process.env.UI_LIVE_EVENT_WAIT_S || 0);
// UI_PASSES=regression runs the fixed-payload passes only (e.g. while no Backend with the current
// contract is up); the report then says the live pass was not run.
const passes = (process.env.UI_PASSES || 'live,regression').split(',');
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
// `tab`: the side panel tab the page starts on (v2 remembers it per viewer); most checks use the list.
async function open({allowErrors = false, allow = null, setup, context: contextOptions, query = '', tab = 'vehicles'} = {}) {
  const expected = url => allowErrors || Boolean(allow && url && allow.test(url));
  const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1, ...contextOptions});
  const page = await context.newPage();
  page.on('pageerror', e => failures.push(`${pass}: pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !expected(m.location()?.url)) failures.push(`${pass}: console: ${m.text()}`); });
  page.on('request', req => { if (!req.url().startsWith(base) && !/^(data|blob):/.test(req.url())) failures.push(`${pass}: external request: ${req.url()}`); });
  // An error status (e.g. the browser's automatic /favicon.ico) is a failure unless the pass provokes errors on purpose.
  page.on('response', res => { if (res.status() >= 400 && !expected(res.url())) failures.push(`${pass}: HTTP ${res.status()}: ${res.url()}`); });
  await page.addInitScript(value => { try { sessionStorage.setItem('t7-side-tab', value); } catch { /* ignore */ } }, tab);
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
// Values keep non-breaking spaces inside («+1 мин 49 с», C4); texts are compared with plain spaces.
const norm = text => String(text ?? '').replaceAll(' ', ' ');
const cardText = page => page.locator('#card').textContent().then(norm);
const incidentText = page => page.locator('#card .incident').textContent();
const forecastText = page => page.locator('#card .forecast').textContent().then(norm);
// Collapsed card sections (C1) are opened before their controls are used.
const openSection = (page, id) => page.locator(`#${id}`).evaluate(d => { if (!d.open) d.querySelector('summary').click(); });
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

// H-1 (user report): no two header parts overlap and none leaves the bar, at any width 1280–1920.
const HEADER_WIDTHS = [1280, 1440, 1600, 1920];
async function headerFits(page, label) {
  const bad = [];
  for (const width of HEADER_WIDTHS) {
    await page.setViewportSize({width, height: VIEWPORT.height});
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const parts = [...document.querySelectorAll('.topbar > .brand, .run > span, .topbar > .data-status, .topbar > .events, .topbar > .diagnostics')]
        .filter(e => e.getClientRects().length).map(e => ({name: e.id || e.className, r: e.getBoundingClientRect()}));
      const hits = [];
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i].r, b = parts[j].r;
        if (a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom && b.y < a.bottom) hits.push(`${parts[i].name}×${parts[j].name}`);
      }
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      const state = document.getElementById('run-state');
      // v2: the attention bar and the map tools share the top of the map; neither may cover the other's buttons.
      const att = document.getElementById('attention'), tools = document.querySelector('.map-tools');
      if (!att.hidden && tools) {
        const a = att.getBoundingClientRect(), t = tools.getBoundingClientRect();
        if (a.x < t.right && t.x < a.right && a.y < t.bottom && t.y < a.bottom) hits.push('attention×map-tools');
        if ([...att.querySelectorAll('button, .sla')].some(e => e.getBoundingClientRect().right > a.right + 0.5)) hits.push('attention buttons cut');
      }
      return [...hits, ...parts.filter(p => p.r.right > bar.right + 0.5).map(p => `${p.name} outside`),
        ...(state.scrollWidth > state.clientWidth + 1 || !state.getClientRects().length ? ['run-state cut'] : [])];
    });
    if (r.length) bad.push(`${width}: ${r.join(', ')}`);
  }
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(250);
  check(bad.length === 0, `${label}: header parts never overlap at ${HEADER_WIDTHS.join('/')} px, run state whole, attention bar clear of map tools (${bad.join('; ') || 'ok'}, H-1)`);
}
// W13 acceptance (ui-review §5): card order, sticky head, no technical identifiers outside
// «Технические подробности», one delay formatter, and the camera following the selection.
const TECH_PATTERNS = [/[0-9a-f]{12,}/, /rev \d+/, /контекст №/, /кадр NDTP/, /canonical_/, /запись расписания/, /\d{4}-\d\d-\d\dT/];
const LABEL_TEXT = /^\S+ · ((опозд\.|опереж\.) [+−]\d+:\d\d|по графику)$/;
async function w13Card(page, label, frameId) {
  const layout = await page.evaluate(() => {
    const box = s => document.querySelector(s)?.getBoundingClientRect();
    const list = document.querySelector('.stops');
    const card = box('#card');
    return {route: box('#route')?.y, actions: card ? card.y + card.height : null, overflow: list ? getComputedStyle(list).overflowY : null,
      fits: list ? list.scrollHeight <= list.clientHeight + 1 : true};
  });
  check(layout.route != null && layout.route + 120 <= layout.actions && (layout.overflow === 'visible' || layout.fits),
    `${label}: stops start in the first screen of the card, no inner scroll (route ${Math.round(layout.route)} + 120 ≤ card bottom ${Math.round(layout.actions)}, L-1)`);
  const sticky = await page.locator('#card').evaluate(card => { const before = card.scrollTop; card.scrollTop = 400;
    const ok = card.querySelector('h2').getBoundingClientRect().y >= card.getBoundingClientRect().y - 1; card.scrollTop = before; return ok; });
  check(sticky, `${label}: header stays visible after card.scrollTop = 400 (L-1)`);
  const visible = await page.locator('#card').evaluate(card => { const copy = card.cloneNode(true); copy.querySelector('#card-tech')?.remove();
    copy.querySelectorAll('[title]').forEach(e => e.removeAttribute('title')); return copy.textContent; });
  const leaks = TECH_PATTERNS.filter(re => re.test(visible)).map(String);
  check(leaks.length === 0 && await page.locator('#card-tech').evaluate(d => !d.open), `${label}: no technical identifiers outside the collapsed «Технические подробности» (${leaks.join(' ') || 'none'}, C-1)`);
  if (frameId != null) {
    const shownFrame = await page.locator('#model-link').getAttribute('data-frame');
    const title = await cardTitle(page);
    const nowFrame = ((await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? []).find(v => String(v.tr_id) === title)?.prediction_input_frame_id;
    check(shownFrame === String(frameId) || shownFrame === String(nowFrame), `${label}: #model-link data-frame = prediction_input_frame_id ${shownFrame} (C-1)`);
  }
  const body = await page.locator('body').innerText();
  const labels = await page.locator('.vehicle-label').allInnerTexts();
  const badLabels = labels.map(t => t.trim()).filter(t => !(LABEL_TEXT.test(t) || /^\S+$/.test(t)));
  check(!/\d+\.\d+ мин/.test(body) && badLabels.length === 0, `${label}: one delay formatter, no decimal minutes; map labels «ID · опозд. +м:сс» or ID only (C5) (${badLabels.join(' | ') || 'ok'}, F-1)`);
}
async function w13Follow(page, label) {
  await page.waitForTimeout(20000);
  const result = await page.evaluate(() => {
    const pane = document.getElementById('map-pane').getBoundingClientRect();
    const overlays = [...document.querySelectorAll('#map-pane .attention:not([hidden]), #map-pane .legend, #map-pane .map-tools, #map-pane .toast, #map-pane .maplibregl-ctrl-bottom-right')]
      .map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
    const hit = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    const me = document.querySelector('.vehicle-label.is-selected')?.getBoundingClientRect();
    const target = document.querySelector('.stop-label[data-kind=target]')?.getBoundingClientRect();
    const inPane = r => r && r.x >= pane.x && r.right <= pane.right && r.y >= pane.y && r.bottom <= pane.bottom;
    return {me: Boolean(me), ok: inPane(me) && !overlays.some(o => hit(me, o)), target: !target || !overlays.some(o => hit(target, o))};
  });
  check(result.me && result.ok && result.target, `${label}: after 20 s the selected vehicle and its target stay in the safe zone (L-3)`);
}
const noScenario = async page => await page.locator('#scenario, #mode-badge, [data-mode], .mode-switch, .direction-chip, #routes, [id^=scenario-]').count() === 0
  && !/сценари|Демо-|mode=demo/i.test(await page.locator('body').textContent());

// M1 dispatcher path on the incident of the given vehicle: event centre → card → take into work →
// note (HTML not executed) → return to new → history.
async function dispatcherPath(page, label) {
  await page.locator('#events-toggle').click();
  const events = page.locator('#events-list .event[data-group=needs]');
  check(await page.locator('#events-panel').isVisible() && await events.count() >= 1, `${label}: «События» opens the queue; the event is in «Требуют реакции»`);
  // Live episodes can end while the check runs (the item moves to «Завершены»): take the first
  // event still waiting, a few times.
  let eventId = null;
  for (let attempt = 0; attempt < 4 && !eventId; attempt += 1) {
    const id = await events.first().getAttribute('data-id', {timeout: 5000}).catch(() => null);
    if (!id) break;
    if (await page.locator(`#events-list .event[data-id="${id}"]`).click({timeout: 4000}).then(() => true).catch(() => false)) eventId = id;
  }
  check(eventId !== null, `${label}: an event waiting for reaction opens its card`);
  if (!eventId) { await page.locator('#tab-vehicles').click(); return null; }
  await page.waitForTimeout(900);
  check(await page.locator(`.toast[data-id="${eventId}"]`).count() === 0, `${label}: opening the event hides its toast`);
  check(await page.locator('#card .incident').getAttribute('data-id') === eventId, `${label}: event → its vehicle's card with the same event`);
  check((await page.locator('#incident-action').textContent()).startsWith('Взять в работу') && /на реакцию|просрочено/.test(await page.locator('#event-sla').textContent())
    && await page.locator('#incident-action').getAttribute('class') === 'primary' && await page.locator('#card-show').getAttribute('class') === null
    && !(await page.locator('#card .event-row').textContent()).includes(' с 0'),
    `${label}: primary action «Взять в работу», «Показать на карте» secondary, SLA badge, «открыто …» not «с …» (C5, C7)`);
  await page.locator('#incident-action').click();
  check(await page.locator('#card .incident-flow').textContent() === 'В работе' && (await incidentText(page)).includes('Взято в работу')
    && await page.locator(`#events-list .event[data-id="${eventId}"]`).getAttribute('data-group') === 'work', `${label}: take moves the event to «В работе»`);
  check(await page.locator('#close-open').getAttribute('class') === 'primary' && await page.locator('#steps').evaluate(d => d.open),
    `${label}: in work — «Закрыть ▾» is the primary action, «Шаги реакции» opened by themselves (C1, C7)`);
  await openSection(page, 'card-history');
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
  await page.locator('#tab-vehicles').click();
  return eventId;
}

try {
  // ============================== LIVE: no interception ==============================
  pass = 'live';
  if (!passes.includes('live')) skipped.push('live: pass not run (UI_PASSES)');
  else {
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
    const nodataWidths = await page.locator('.vehicle-label[data-level=nodata]').evaluateAll(ls => ls.map(l => l.offsetWidth));
    check(Math.max(0, ...nodataWidths) <= 70 && !(await page.locator('.vehicle-label').allInnerTexts()).some(t => t.includes('нет прогноза')),
      `overview: labels without a prediction are the ID only, ≤ 70 px (max ${Math.max(0, ...nodataWidths)}, M-3)`);
    await headerFits(page, 'live');
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
      check(/Сейчас: .*\(факт|Факт опоздания пока не определён/.test(text), 'card: the current delay is the fact, next to the forecast (C2)');
      const roles = (routeBody?.stops ?? []).map(s => s.role);
      const target = (routeBody?.stops ?? []).find(s => s.role === 'target');
      // Live rows change: if the vehicle lost its current forecast since the snapshot (e.g. its GPS
      // turned invalid), the model-specific card checks are skipped, not failed.
      const modelNow = await page.locator('#card').getAttribute('data-level') !== 'nodata';
      if (!modelNow) skipped.push(`live: ${id} lost its current forecast during the check — model-specific card checks not asserted`);
      if (target && modelNow) {
        const targetRow = page.locator('.stops li[data-role=target]');
        const expected = routeBody.prediction_s != null ? shiftedText(target.time, routeBody.prediction_s) : null;
        // Live forecasts move between two reads: the row is compared with the route read before and after.
        const shown = await targetRow.textContent();
        const again = (await api(page, `/api/route/${encodeURIComponent(id)}`)).body;
        const target2 = (again?.stops ?? []).find(s => s.role === 'target');
        const expected2 = again?.prediction_s != null && target2 ? shiftedText(target2.time, again.prediction_s) : null;
        check(await targetRow.count() === 1 && (await page.locator('.stops li[data-group=target]').textContent()).includes('прогноз модели')
          && (!expected || shown.includes(expected) || (expected2 && shown.includes(expected2))), `card: target = plan + prediction_s «прогноз модели» (${expected}${expected2 && expected2 !== expected ? ` / ${expected2}` : ''}; shown «${shown.replace(/\s+/g, ' ')}» under «${(await page.locator('.stops li[data-group=target]').textContent()).replace(/\s+/g, ' ')}»)`);
        check(await page.locator('.stop-label[data-kind=target]').count() === 1
          && inside(await page.locator('.stop-label[data-kind=target]').boundingBox(), await page.locator('#map-pane').boundingBox()), 'map: target time label drawn inside the map (never at 0/0)');
      } else if (!target) skipped.push(`live: route of ${id} has no target stop at this moment`);
      if (roles.includes('before_target') && routeBody.cur_dev_s != null) check((await page.locator('.stops li[data-group=before_target]').textContent()).includes('факт, не прогноз'), 'card: stops before the target = plan + cur_dev_s, group «(факт, не прогноз)»');
      check((await page.locator('#route').textContent()).split('факт, не прогноз').length - 1 <= 1 && await page.locator('.stops li.stop-row').evaluateAll(items => items.every(li => li.querySelector('.stop-no'))),
        'card: the fact note once per group, every stop numbered (C-3)');
      if (roles.includes('passed')) check(!/→/.test(await page.locator('.stops li[data-role=passed]').first().textContent()), 'card: passed stops show the plan time only');
      if (roles.includes('after_target') && routeBody.prediction_s != null && modelNow) {
        check(await page.locator('#shift-after-target').isChecked() && (await page.locator('.stops li[data-group=after_target]').textContent()).includes('После цели · допущение') && (await page.locator('.stops li[data-group=after_target]').textContent()).includes('Не прогноз модели'), 'card: after the target «допущение», «Не прогноз модели», toggle on by default (C6)');
        await page.locator('#shift-after-target').uncheck();
        check(!(await page.locator('.stops').textContent()).includes('допущение') && (await page.locator('.stops li[data-group=target]').textContent()).includes('прогноз модели'), 'card: toggle off hides the assumption, keeps the model value');
        await page.locator('#shift-after-target').check();
      }
      check((await page.locator('#route .route-caption').textContent()).includes('плановый маршрут наряда'), 'card: the line is the planned route of the assignment, not a GPS track');
      check((await page.locator('#legend-route').textContent()).includes('впереди') && (await page.locator('.legend').boundingBox()).height <= 84, 'legend with a selection: route row shown, ≤ 84 px');
      // Route layers exactly as route_line asks: on_route → passed + ahead; otherwise dim (+ leader).
      const {body: rowNow} = await api(page, '/api/snapshot');
      const me = rowNow?.snapshot?.vehicles?.find(v => String(v.tr_id) === id);
      const expectedLayers = routeLayersFor(routeBody?.route_line, me && coordOk(me.lon, me.lat) ? [Number(me.lon), Number(me.lat)] : null).join(',');
      check(routeBody?.route_line && await page.locator('#map-pane').getAttribute('data-route-layers') === expectedLayers,
        `route layers follow route_line.split_reason (${routeBody?.route_line?.split_reason} → «${expectedLayers}»)`);
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
      await w13Card(page, 'live W13', me?.prediction_input_frame_id ?? null);
      await w13Follow(page, 'live W13');
      await shot(page, 'live-w13-follow-20s-1920.png');
    }

    // A vehicle without a current prediction: honest reason, not a green state.
    // A forecast held over a target change is a current forecast (W14), not «no prediction».
    const noForecast = v => v.status !== 'normal' && v.reason !== 'prediction_held_previous_target';
    const freshRows = async () => (await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? [];
    const now = await freshRows();
    const without = now.find(v => noForecast(v) && v.location_valid) ?? now.find(noForecast);
    if (without) {
      await page.locator(`#vehicles .vehicle[data-id="${without.tr_id}"]`).click();
      await page.waitForTimeout(1500);
      const text = await cardText(page);
      const after = (await freshRows()).find(v => String(v.tr_id) === String(without.tr_id));
      if (!after || !noForecast(after) || after.reason !== without.reason) skipped.push(`live: ${without.tr_id} changed state during the check — no-prediction card not asserted`);
      else check(await page.locator('#card').getAttribute('data-level') === 'nodata' && /Цель прогноза не выбрана|Прогноза для цели пока нет|Прогноз устарел|Прогноза не будет|Прогон завершён|Прогноз не обновляется/.test(text)
        && (!without.reason || text.includes(reasonText(without.reason)) || run?.state === 'completed' || text.includes('Прогон завершён')), `no prediction (${without.reason}): «${reasonText(without.reason)}», not green`);
      await shot(page, 'live-4-no-prediction-1920.png');
    } else skipped.push('live: every vehicle has a current prediction — no-prediction card not shown');
    // Live rows change: take the invalid-GPS vehicle from a fresh snapshot and check the card against the row it shows.
    const invalid = ((await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? []).find(v => !v.location_valid);
    if (invalid) {
      await page.locator(`#vehicles .vehicle[data-id="${invalid.tr_id}"]`).click();
      // The card shows the last poll; the row is read on both sides of one poll so a GPS fix
      // arriving in between skips the check instead of comparing two different snapshots.
      await page.waitForTimeout(900);
      const rowOf = async () => ((await api(page, '/api/snapshot')).body?.snapshot?.vehicles ?? []).find(v => String(v.tr_id) === String(invalid.tr_id));
      const before = await rowOf();
      await page.waitForTimeout(POLL_SPAN_MS);
      const row = await rowOf();
      if (before?.location_valid !== row?.location_valid) skipped.push(`live: ${invalid.tr_id} changed GPS validity during the check — invalid-GPS card not asserted`);
      else if (row && !row.location_valid && coordOk(row.lon, row.lat)) {
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
  if (!passes.includes('regression')) throw Object.assign(new Error('regression not requested'), {skip: true});
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
    model_version: v.model_version, artifact_sha256: v.artifact_sha256, route_line: lineOf(v), ...extra});
  // /api/route `route_line` (impl-A W11-A2): the planned line through the window's stops, split at the vehicle.
  const lineOf = (v, extra = {}) => {
    const line = [[v.lon - 0.006, v.lat - 0.0025], [v.lon + 0.005, v.lat + 0.0017], [v.target_lon, v.target_lat], [v.target_lon + 0.006, v.target_lat + 0.002]];
    const split = [v.lon, v.lat];
    return {line, passed: [line[0], split], ahead: [split, ...line.slice(1)], split, split_reason: 'on_route', nearest: split,
      off_route: false, route_offset_m: 0, ...extra};
  };
  const state = {status: 'online', snapshot: null, route: {}, routes: null};
  // /api/routes (impl-A W11-A): every vehicle's planned line in the display window.
  const routesOf = vehicles => ({status: 'online', reason: null, checked_at: '2026-09-27T12:00:00Z', run_id: state.snapshot?.run?.run_id ?? null,
    clock_time: '2026-01-06T06:47:10', window_start: '2026-01-06T06:32:10', window_end: '2026-01-06T07:32:10',
    routes: vehicles.map(v => ({tr_id: v.tr_id, unit_id: 1, line: v.route_not_started ? [] : lineOf(v).line, line_times: [],
      off_route: v.off_route ?? false, route_offset_m: v.route_offset_m ?? 0, route_not_started: v.route_not_started ?? false}))});
  const setSnapshot = (run, vehicles, sourceClock = 'simulation') => { state.status = 'online'; state.snapshot = {schema_version: 'transport.backend-vehicles.v1', revision: 1,
    source_clock: sourceClock, clock_time: run?.dataset_time ?? '2026-01-06T06:47:10', run, vehicles}; };
  const setup = page => Promise.all([
    page.route('**/api/snapshot', route => route.fulfill({contentType: 'application/json', body: JSON.stringify(state.status === 'online'
      ? {status: 'online', reason: null, age_s: 0, fetched_at: '2026-09-27T12:00:00Z', checked_at: '2026-09-27T12:00:00Z', snapshot: state.snapshot}
      : {status: 'offline', reason: 'Backend HTTP 503', age_s: 9, fetched_at: '2026-09-27T12:00:00Z', checked_at: '2026-09-27T12:00:09Z', snapshot: state.snapshot})})),
    page.route('**/api/routes', route => route.fulfill({contentType: 'application/json',
      body: JSON.stringify(state.routes ?? routesOf(state.snapshot?.vehicles ?? []))})),
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
      && (await page.locator('#prediction-updating').getAttribute('title')).includes('35 с') && await page.locator('#card .updating').count() === 0,
    'prediction_updating: normal level, pulse «обновляется», age in the title (C-2)');

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
    check((await forecastText(page)).includes('Прогноза для цели пока нет') && (await cardText(page)).includes('Причина: прогноз обновляется для новой цели'), 'prediction_pending: quiet «Прогноза для цели пока нет», reason in the card (C3)');
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
    const stops = page.locator('.stops li.stop-row');
    const group = role => page.locator(`.stops li[data-group=${role}]`).textContent();
    check((await stops.nth(0).textContent()).includes('06:44') && !(await stops.nth(0).textContent()).includes('→') && (await group('passed')).includes('Пройдено'), 'passed stop: plan time only');
    check((await stops.nth(1).textContent()).includes('06:52 → 06:54') && (await group('before_target')).includes('(факт, не прогноз)') && norm(await group('before_target')).includes('+1 мин 35 с') && (await stops.nth(1).textContent()).includes('+1:35'), 'before target: plan + cur_dev_s «+1:35», group «перенесено текущее опоздание +1 мин 35 с (факт, не прогноз)»');
    check((await stops.nth(2).textContent()).includes('06:58 → 07:01') && (await group('target')).includes('прогноз модели') && (await stops.nth(2).textContent()).includes('+3:20') && !/\d\d:\d\d:\d\d/.test(await stops.nth(2).textContent()), 'target: plan + prediction_s «+3:20», no seconds in the card (C4), «прогноз модели»');
    check((await stops.nth(3).textContent()).includes('07:03 → ≈07:06') && (await group('after_target')).includes('допущение') && (await group('after_target')).includes('Не прогноз модели. Показан тот же сдвиг, что у цели.'), 'after target: «≈» time, «допущение», the caveat line (C6)');
    check(!/~|\d+\.\d+ мин/.test(await page.locator('#card').innerText()), 'card: no tilde and no decimal minutes (F-1)');
    check(await page.locator('.stops li[data-stop=ZN]').count() === 0 && (await page.locator('[data-action=stops-after]').textContent()).includes('Ещё 1'),
      'after the target: two rows, then «Ещё N» (C6)');
    await page.locator('[data-action=stops-after]').click();
    check(await page.locator('.stops li[data-stop=Z0]').getAttribute('title') === 'Координаты нет — на карте не показана'
      && await page.locator('.stops li[data-stop=ZN]').getAttribute('title') === 'Координаты нет — на карте не показана'
      && (await page.locator('#route').textContent()).includes('2 остановок без координат на карте не показаны')
      && (await page.locator('#route').textContent()).includes('2 остановок без координат исключены Backend'), 'stops at 0/0 or without coordinates are listed but not drawn, and counted');
    check(await page.locator('.stop-label').count() === 2 && (await page.locator('.stop-label[data-kind=target]').textContent()).includes('ЦЕЛЬ · ост. 3 · 06:58 → 07:01 · +3:20')
      && (await page.locator('.stop-label[data-kind=next]').textContent()).includes('след. ост. 2 · 06:52 → 06:54 · по факту'), 'map labels: target and nearest future stop only, C5 texts');
    const pane = await page.locator('#map-pane').boundingBox();
    for (const kind of ['target', 'next']) check(inside(await page.locator(`.stop-label[data-kind=${kind}]`).boundingBox(), pane), `map label ${kind} inside the map`);
    await page.locator('#shift-after-target').uncheck();
    check((await stops.nth(3).textContent()).includes('07:03') && !(await stops.nth(3).textContent()).includes('→'), 'toggle off: after-target stops show plan time only');
    await page.locator('#shift-after-target').check();
    await shot(page, 'regression-3-route-bad-coords-1920.png');
    // A degraded row keeps a numeric prediction: it is not shown as the model's value or its assumption.
    setSnapshot(RUN('run-A-0001'), [{...a, status: 'degraded', reason: 'prediction_pending'}, b]);
    await page.waitForFunction(() => document.getElementById('card').dataset.level === 'nodata', null, {timeout: 6000});
    await page.waitForTimeout(300);
    const degraded = await page.locator('.stops').textContent();
    check(!degraded.includes('прогноз модели') && !degraded.includes('допущение') && (await page.locator('.stops li[data-group=target]').textContent()).includes('прогноз устарел')
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
      check((await cardText(page)).includes(`Причина: ${label}`) && await page.locator('#card').getAttribute('data-level') === 'nodata', `reason ${reason} → «${label}», not green`);
      if (reason === 'ml_unreachable_or_timeout') await shot(page, 'regression-4-ml-unreachable-1920.png');
    }

    // Backend offline: last snapshot, honest status, no substitution.
    state.status = 'offline';
    await page.waitForFunction(() => document.getElementById('data-status').textContent.includes('Backend недоступен · последний снимок'), null, {timeout: 6000});
    check((await page.locator('#attention').textContent()).includes('Backend недоступен') && await page.locator('#run-id').getAttribute('data-run-id') === 'run-A-0001', 'offline: last snapshot kept, run on screen unchanged');
    await shot(page, 'regression-5-backend-offline-1920.png');
    await headerFits(page, 'regression offline');

    // A new run ID (stack recreated): events, history, selection and route are dropped.
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    setSnapshot(RUN('run-B-0002', {progress: 0.01, dataset_time: '2026-01-06T06:31:00'}), [{...a, prediction_s: 30}, {...b, prediction_s: 20, status: 'normal', reason: null}]);
    state.route = {900001: routeOf(a), 900002: routeOf(b)};
    await page.waitForFunction(() => document.getElementById('run-id').dataset.runId === 'run-B-0002', null, {timeout: 8000});
    await page.waitForTimeout(500);
    await page.locator('#events-toggle').click();
    check(await page.locator('#events-list .event').count() === 0 && await page.locator('#events-unread').isHidden() && await page.locator('#card .card-empty').count() === 1
      && await page.locator('.stop-label').count() === 0 && await page.locator('.toast').count() === 0, 'new run_id: events, history, selection and route context cleared');
    await page.locator('#tab-vehicles').click();
    // Outside SOURCE_CLOCK=simulation Backend has no run: said so, no invented run or speed-up.
    setSnapshot(null, [a], 'dataset_wall');
    await page.waitForFunction(() => document.getElementById('run-source').textContent.includes('Backend без прогона'), null, {timeout: 6000});
    check((await page.locator('#run-source').textContent()).includes('часы dataset_wall') && await page.locator('#run-id').textContent() === 'прогона нет'
      && await page.locator('#run-speed').textContent() === 'Ускорение неизвестно', 'snapshot.run = null: no run, no speed-up invented');
    check(await noScenario(page), 'no scenario elements in any state');
    await page.close();
  }

  {
    // W13 (ui-review §5): banner without repeats (L-5), one channel per event (E-1), a target
    // after the data window (C-5), the run end as a normal end, not a failure (H-2).
    const w = bus('900001', center[0], center[1], {prediction_s: 200});
    const x = bus('900003', center[0] - 0.03, center[1] - 0.01, {prediction_s: 250});
    const calm = bus('900004', center[0] + 0.03, center[1] + 0.01, {prediction_s: 40});
    const late = bus('900005', center[0] + 0.02, center[1] - 0.012, {prediction_s: null, status: 'nodata', reason: 'no_target_in_horizon',
      target_time_begin: '2026-01-06T08:51:00', prediction_input_frame_id: null});
    setSnapshot(RUN('run-W13-0001'), [w, x, calm, late]);
    state.routes = null;
    state.route = {900001: routeOf(w), 900003: routeOf(x), 900004: routeOf(calm)};
    const page = await open({setup, allow: /\/api\/route\//});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForFunction(() => document.querySelector('#attention button'), null, {timeout: 8000});
    await headerFits(page, 'regression running');
    const first = (await page.locator('#attention').textContent()).includes('900001') ? '900001' : '900003';
    await page.locator('#attention button').first().click();
    await page.waitForTimeout(POLL_SPAN_MS);
    check(await cardTitle(page) === first && !(await page.locator('#attention').textContent()).includes(first)
      && (await page.locator('#attention button').first().textContent()) === 'Показать', `banner «Показать» opens ${first}; the banner then shows another warning, not the selected one (L-5)`);
    await w13Card(page, 'regression W13', `r:${first}`);
    // L-3: a manual pan stops following; «Следить за X» next to «Все ТС» turns it back on.
    const pane = await page.locator('#map-pane').boundingBox();
    await page.mouse.move(pane.x + 500, pane.y + 500); await page.mouse.down();
    await page.mouse.move(pane.x + 700, pane.y + 620, {steps: 8}); await page.mouse.up();
    await page.waitForTimeout(400);
    const followBox = await page.locator('#follow').boundingBox();
    const overviewBox = await page.locator('#overview').boundingBox();
    check(await page.locator('#follow').isVisible() && (await page.locator('#follow').textContent()) === `Следить за ${first}` && !overlap(followBox, overviewBox),
      `manual pan: «Следить за ${first}» appears beside «Все ТС» (L-3)`);
    await page.locator('#follow').click();
    await page.waitForTimeout(900);
    check(await page.locator('#follow').isHidden() && inside(await page.locator('.vehicle-label.is-selected').boundingBox(), pane), '«Следить» brings the vehicle back and hides the button (L-3)');
    await shot(page, 'regression-w13-card-l1-c1-1920.png');
    await page.locator('#incident-action').click();
    check(await page.locator('#incident-action').textContent() === 'Вернуть в новые' && await page.locator('#card .incident-flow').textContent() === 'В работе'
      && await page.locator('#event-sla').textContent() === 'в работе', '«Взять в работу» → chip and badge «В работе», «Вернуть в новые» offered');
    await page.locator('#card-close').click();
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    check(!(await page.locator('#attention').textContent()).includes(first), `${first} in work: not back in the banner for two polls (L-5)`);
    // Two new events while 900001's card is open: at most two toasts, none for the open card, none «в норме».
    await page.locator(`#vehicles .vehicle[data-id="${first}"]`).click();
    setSnapshot(RUN('run-W13-0001'), [{...w, prediction_s: 400}, {...x, prediction_s: 420}, {...calm, prediction_s: 260}, late]);
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    const toastTexts = await page.locator('.toast').allInnerTexts();
    check(toastTexts.length <= 2 && toastTexts.every(t => !t.includes(first) && !t.includes('в норме')) && toastTexts.every(t => /\+\d+ мин( \d+ с)?|по графику/.test(norm(t))),
      `toasts: ≤ 2, none for the open card ${first}, no «в норме», delay as «+N мин M с» (${toastTexts.map(t => t.replace(/\s+/g, ' ')).join(' | ') || 'none'}, E-1)`);
    // L-4: one panel at a time, and an open panel hides the toasts under it.
    await page.locator('#diagnostics summary').click();
    const toastsHidden = await page.locator('.toast').evaluateAll(ts => ts.every(t => getComputedStyle(t).visibility === 'hidden'));
    await page.locator('#events-toggle').click();
    check(toastTexts.length > 0 && toastsHidden && !(await page.locator('#diagnostics').evaluate(d => d.open)) && await page.locator('#events-panel').isVisible()
      && await page.locator('.toast').evaluateAll(ts => ts.every(t => getComputedStyle(t).visibility !== 'hidden')),
      'open diagnostics hides the toasts; opening «События» closes diagnostics (L-4)');
    await page.locator('#tab-vehicles').click();
    // M-5 and L-2: controls in Russian; with a selection the list keeps ≥ 160 px.
    check(await page.locator('.maplibregl-ctrl-zoom-in').getAttribute('aria-label') === 'Приблизить' && await page.locator('.maplibregl-ctrl-zoom-out').getAttribute('aria-label') === 'Отдалить'
      && (await page.locator('#overview').textContent()) === 'Все ТС', 'map controls «Приблизить» / «Отдалить», «Все ТС» (M-5)');
    check(await page.locator('#vehicles').evaluate(l => l.clientHeight) >= 160, 'with a selection the list keeps ≥ 160 px (L-2)');
    // C-5: the target lies after the data window: said so instead of «план 08:51 · прогноза нет».
    await page.locator('#vehicles .vehicle[data-id="900005"]').click();
    await page.waitForTimeout(700);
    const lateText = await cardText(page);
    check(lateText.includes('Прогноза не будет: цель по расписанию позже конца данных прогона.') && !lateText.includes('прогноза нет'), 'target after dataset_end: «Прогноза не будет: цель по расписанию позже конца данных прогона.» (C3)');
    await shot(page, 'regression-w13-target-outside-run-1920.png');
    // H-2: the run completed; every vehicle has lost its prediction (the device is disconnected).
    const ended = [w, x, calm, late].map(v => ({...v, status: 'nodata', reason: 'disconnected', prediction_s: null, connected: false}));
    setSnapshot(RUN('run-W13-0001', {state: 'completed', progress: 1, dataset_time: '2026-01-06T08:30:00'}), ended);
    await page.waitForFunction(() => document.getElementById('run').dataset.state === 'completed', null, {timeout: 8000});
    await page.waitForTimeout(POLL_SPAN_MS);
    const notes = await page.locator('.vehicle-note').allInnerTexts();
    check((await page.locator('#attention').textContent()).includes('Прогон завершён') && await page.locator('#attention').getAttribute('data-level') === 'normal'
      && notes.length > 0 && notes.every(n => !/устройство отключено/i.test(n)) && notes.some(n => /прогон завершён/i.test(n)) && await page.locator('.toast').count() === 0,
    `run completed: banner «Прогон завершён» (normal), list «прогон завершён», not «Устройство отключено», no toasts (H-2)`);
    check((await page.locator('.vehicle-label').allInnerTexts()).every(t => /^\S+$/.test(t.trim())), 'run completed: map labels are the ID only, no «нет прогноза» (H-2)');
    await shot(page, 'regression-w13-run-completed-1920.png');
    // L-2: without a selection 16 rows fit the list without scrolling.
    await page.locator('#card-close').click();
    setSnapshot(RUN('run-W13-0001', {state: 'completed', progress: 1, dataset_time: '2026-01-06T08:30:00'}),
      Array.from({length: 16}, (_, i) => ({...ended[i % ended.length], tr_id: String(910000 + i), lon: center[0] + (i % 4) * 0.01, lat: center[1] + Math.floor(i / 4) * 0.006})));
    await page.waitForFunction(() => document.querySelectorAll('#vehicles .vehicle').length === 16, null, {timeout: 6000});
    check(await page.locator('#vehicles').evaluate(l => l.scrollHeight <= l.clientHeight + 1), 'without a selection 16 vehicles fit the list, no inner scroll (L-2)');
    await shot(page, 'regression-w13-list-16-1920.png');
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
    check((await page.locator('.vehicle-label.is-selected').getAttribute('data-symbol'))?.split('|')[4] === 'selected', 'selected vehicle: ring and larger icon');
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

  // Planned routes (W11/W12): overview lines of all vehicles, the selected route split by Backend
  // route_line, off-route leader and mark, heading arrow direction, «наряд ещё не начался».
  {
    const a = bus('900001', center[0], center[1], {prediction_s: 200, heading: null});
    const east = bus('900002', center[0] + 0.03, center[1] + 0.01, {prediction_s: 40, heading: 90});
    const off = bus('900006', center[0] - 0.03, center[1] - 0.01, {prediction_s: 60, off_route: true, route_offset_m: 3440});
    const later = bus('900007', center[0] + 0.01, center[1] - 0.02, {status: 'unavailable', reason: 'no_target_in_horizon', prediction_s: null,
      target_stop_id: null, route_not_started: true});
    setSnapshot(RUN('run-F-0006'), [a, east, off, later]);
    state.routes = null;
    state.route = {900001: routeOf(a),
      900006: routeOf(off, {route_line: lineOf(off, {split_reason: 'off_route', passed: [], ahead: [], split: null,
        nearest: [off.lon + 0.02, off.lat + 0.012], off_route: true, route_offset_m: 3440})})};
    const page = await open({setup, query: '?debug', allow: /\/api\/route\//});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(2500);
    const rendered = layer => page.evaluate(l => window.__map.queryRenderedFeatures({layers: [l]}).length, layer);
    check(await rendered('routes-all') > 0 && await page.evaluate(() => ['route-path', 'route-path-casing'].every(l => !window.__map.getLayer(l))),
      'overview: planned routes of all vehicles drawn thin; no GPS path layers exist');
    check((await page.locator('#vehicles .vehicle[data-id="900006"]').textContent()).includes('вне маршрута ~3,4 км')
      && (await page.locator('.vehicle-label[data-id="900006"]').getAttribute('data-symbol')).endsWith('|≠'), 'off route: list says «вне маршрута ~3,4 км», icon has «≠»');
    await shot(page, 'regression-10-overview-routes-1920.png');

    // Heading 90° points east: dark arrow pixels right of the icon, none left, above or below.
    const arrow = await page.evaluate(async ([lon, lat]) => {
      const map = window.__map;
      map.jumpTo({center: [lon, lat], zoom: 15});
      await new Promise(resolve => map.once('idle', resolve));
      const p = map.project([lon, lat]);
      const source = map.getCanvas();
      const canvas = Object.assign(document.createElement('canvas'), {width: source.width, height: source.height});
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0);
      const ratio = source.width / source.clientWidth;
      const dark = (x0, y0, x1, y1) => {
        const d = ctx.getImageData(Math.round((p.x + x0) * ratio), Math.round((p.y + y0) * ratio), Math.round((x1 - x0) * ratio), Math.round((y1 - y0) * ratio)).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 70 && d[i + 1] < 80 && d[i + 2] < 90) n += 1;
        return n;
      };
      return {east: dark(14, -5, 23, 5), west: dark(-23, -5, -14, 5), north: dark(-5, -23, 5, -14), south: dark(-5, 14, 5, 23)};
    }, [east.lon, east.lat]);
    check(arrow.east > 10 && arrow.west + arrow.north + arrow.south < 4, `heading 90° → arrow east of the icon (dark px east ${arrow.east}, west ${arrow.west}, north ${arrow.north}, south ${arrow.south})`);
    await shot(page, 'regression-11-heading-east-z15-1920.png');
    check(await page.evaluate(() => document.querySelectorAll('.vehicle-label').length) > 0, 'heading: map still labelled');

    // Selected on route: passed dim + ahead bright with arrows.
    await page.locator('#vehicles .vehicle[data-id="900001"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'ok', null, {timeout: 8000});
    await page.waitForTimeout(1200);
    check(await page.locator('#map-pane').getAttribute('data-route-layers') === 'route-passed,route-ahead'
      && await rendered('route-ahead') > 0 && await rendered('route-passed') > 0, 'on_route: data-route-layers «route-passed,route-ahead», both drawn');
    check(await rendered('route-ahead-arrows') > 0, 'on_route: direction arrows along the ahead part');
    check(await page.evaluate(() => { const ids = window.__map.getStyle().layers.map(l => l.id); return ids.indexOf('route-passed') < ids.indexOf('route-ahead'); }), 'ahead is drawn above passed');
    await shot(page, 'regression-12-selected-on-route-1920.png');

    // Off route: whole line dim, dashed leader to `nearest`, label and card text.
    await page.locator('#vehicles .vehicle[data-id="900006"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'ok', null, {timeout: 8000});
    await page.waitForTimeout(1200);
    check(await page.locator('#map-pane').getAttribute('data-route-layers') === 'route-dim,offroute-leader'
      && await rendered('route-dim') > 0 && await rendered('route-ahead') === 0, 'off_route: data-route-layers «route-dim,offroute-leader», no split');
    check((await page.locator('.stop-label[data-kind=offroute]').textContent()).includes('вне маршрута ~3,4 км')
      && (await page.locator('#off-route').textContent()).includes('координаты не совпадают с маршрутом наряда')
      && (await page.locator('#off-route').textContent()).includes('прогноз может быть неверен'), 'off_route: map label and card say «вне маршрута ~3,4 км», prediction may be wrong');
    const offOverlaps = await labelOverlaps(page);
    check(offOverlaps.length === 0, `off_route: no two map labels intersect (${offOverlaps.join(', ') || 'none'})`);
    await shot(page, 'regression-13-selected-off-route-1920.png');

    // No segment in the window: whole line dim, no leader.
    state.route['900006'] = routeOf(off, {route_line: lineOf(off, {split_reason: 'no_segment', passed: [], ahead: [], split: null})});
    await page.waitForFunction(() => document.getElementById('map-pane').dataset.routeLayers === 'route-dim', null, {timeout: 8000}).catch(() => {});
    check(await page.locator('#map-pane').getAttribute('data-route-layers') === 'route-dim' && await page.locator('.stop-label[data-kind=offroute]').count() === 0,
      'no_segment: whole line dim, no leader');

    // The assignment has not started yet.
    await page.locator('#vehicles .vehicle[data-id="900007"]').click();
    await page.waitForTimeout(800);
    check((await forecastText(page)).includes('Цель прогноза не выбрана') && (await forecastText(page)).includes('наряд ещё не начался. Прогноз появится, когда ТС выйдет на маршрут')
      && (await page.locator('#vehicles .vehicle[data-id="900007"]').textContent()).includes('Прогноз появится, когда ТС выйдет на маршрут'), 'route_not_started: «прогноз появится, когда ТС выйдет на маршрут» in card and list');
    await page.close();
  }

  // W14: the two directions of an out-and-back route on one street are drawn apart (line-offset to
  // the right of travel), for the selected route and the overview; the line is a dense
  // road-following polyline and the stops come from the route's stops, never from its vertices.
  {
    const leg = (lon, lat) => Array.from({length: 101}, (_, i) => [lon + i * 0.0001, lat]); // 0.01° east, 101 vertices
    const outAndBack = (lon, lat) => { const out = leg(lon, lat); return [...out, ...[...out].reverse().slice(1)]; };
    const sel = bus('900011', center[0] + 0.02, center[1] + 0.02, {prediction_s: 200, heading: 90,
      target_lon: center[0] + 0.03, target_lat: center[1] + 0.02});
    const other = bus('900012', center[0] - 0.03, center[1] - 0.02, {prediction_s: 40, heading: 90});
    const selLine = outAndBack(sel.lon, sel.lat);
    const otherLine = outAndBack(other.lon, other.lat);
    setSnapshot(RUN('run-W14-0001'), [sel, other]);
    state.routes = {...routesOf([sel, other]), routes: [
      {tr_id: sel.tr_id, unit_id: 1, line: selLine, line_times: [], off_route: false, route_offset_m: 0, route_not_started: false},
      {tr_id: other.tr_id, unit_id: 1, line: otherLine, line_times: [], off_route: false, route_offset_m: 0, route_not_started: false}]};
    state.route = {900011: routeOf(sel, {
      stops: [{stop_id: 'S1', time: '06:44:00', lon: sel.lon, lat: sel.lat, role: 'passed'},
        {stop_id: sel.target_stop_id, time: '06:58:00', lon: sel.target_lon, lat: sel.target_lat, role: 'target'},
        {stop_id: 'S3', time: '07:10:00', lon: sel.lon + 0.002, lat: sel.lat, role: 'after_target'}],
      route_line: {line: selLine, passed: [selLine[0], selLine[1]], ahead: selLine.slice(1), split: selLine[1], split_reason: 'on_route',
        nearest: selLine[1], off_route: false, route_offset_m: 0}})};
    const page = await open({setup, query: '?debug', allow: /\/api\/route\//});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(2000);
    await page.locator('#vehicles .vehicle[data-id="900011"]').click();
    await page.waitForFunction(() => document.getElementById('route')?.dataset.status === 'ok', null, {timeout: 8000});
    await page.locator('#overview').click(); // stop following: the camera is moved by the check below
    await page.waitForTimeout(800);
    // Rows of one pixel column that the given layers paint: the column with the layers shown minus
    // the same column with them hidden; returns the painted runs [from, to] in CSS px from the line.
    const bands = (layers, lon, lat) => page.evaluate(async ([ids, lon, lat]) => {
      const map = window.__map;
      map.jumpTo({center: [lon, lat], zoom: 15});
      await new Promise(resolve => map.once('idle', resolve));
      const column = async visible => {
        for (const id of ids) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        map.triggerRepaint();
        await new Promise(resolve => map.once('idle', resolve));
        const source = map.getCanvas();
        const ratio = source.width / source.clientWidth;
        const canvas = Object.assign(document.createElement('canvas'), {width: source.width, height: source.height});
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const p = map.project([lon, lat]);
        const data = ctx.getImageData(Math.round(p.x * ratio), Math.round((p.y - 20) * ratio), 1, Math.round(40 * ratio)).data;
        return {data, ratio};
      };
      const on = await column(true);
      const off = await column(false);
      for (const id of ids) map.setLayoutProperty(id, 'visibility', 'visible');
      const painted = [];
      for (let row = 0; row < on.data.length / 4; row += 1) {
        const i = row * 4;
        painted.push(Math.abs(on.data[i] - off.data[i]) + Math.abs(on.data[i + 1] - off.data[i + 1]) + Math.abs(on.data[i + 2] - off.data[i + 2]) > 30);
      }
      const runs = [];
      painted.forEach((v, row) => { if (v && (row === 0 || !painted[row - 1])) runs.push([row, row]); else if (v) runs[runs.length - 1][1] = row; });
      return runs.map(([a, b]) => [a / on.ratio - 20, b / on.ratio - 20]);
    }, [layers, lon, lat]);
    const mid = v => [v.lon + 0.005, v.lat];
    const selectedBands = await bands(['route-ahead'], ...mid(sel));
    check(selectedBands.length >= 2 && selectedBands.some(([a]) => a > 0) && selectedBands.some(([, b]) => b < 0),
      `selected out-and-back: the two directions are two separate bands, one each side of the street (${JSON.stringify(selectedBands.map(b => b.map(Math.round)))})`);
    // Eastbound (outbound) runs south of the street = right of travel; westbound north.
    const overviewBands = await bands(['routes-all'], ...mid(other));
    check(overviewBands.length >= 2 && overviewBands.some(([a]) => a > 0) && overviewBands.some(([, b]) => b < 0),
      `overview out-and-back: two separate thin lines, not one on top of the other (${JSON.stringify(overviewBands.map(b => b.map(Math.round)))})`);
    await page.evaluate(([lon, lat]) => window.__map.jumpTo({center: [lon, lat], zoom: 15}), mid(sel));
    await page.waitForTimeout(600);
    await shot(page, 'regression-w14-out-and-back-z15-1920.png');
    // Stops from the route's stops: 3 stops (1 is the target symbol), not 201 line vertices.
    const stops = await page.evaluate(() => new Set(window.__map.queryRenderedFeatures({layers: ['route-stops']}).map(f => f.geometry.coordinates.join(','))).size);
    check(stops === 2 && (await page.locator('.stops li.stop-row').count()) === 3,
      `dense road-following line: stops drawn from the route's stops (${stops} on the map + target, 3 in the card), not from its vertices`);
    await page.close();
  }

  // W14 prediction continuity: while the new target's first forecast is computed, Backend holds the
  // previous target with its forecast (degraded / prediction_held_previous_target, state updating).
  // Quiet: the same level and value, a small «обновляется», no «нет прогноза», no toast, no jump.
  {
    const w = bus('900021', center[0], center[1], {prediction_s: 200});
    const n = bus('900022', center[0] + 0.02, center[1] + 0.01, {prediction_s: 40});
    const z = bus('900023', center[0] - 0.02, center[1] - 0.01, {prediction_s: 20});
    const held = v => ({...v, status: 'degraded', reason: 'prediction_held_previous_target', prediction_state: 'updating', prediction_updating: true,
      alert: null, prediction_held_from_target: v.target_stop_id, planned_target_stop_id: `N${v.tr_id}`, revision: v.revision + 1});
    setSnapshot(RUN('run-W14H-0001'), [w, n, z]);
    state.routes = null;
    state.route = {900021: routeOf(w), 900022: routeOf(n), 900023: routeOf(z)};
    const page = await open({setup, allow: /\/api\/route\//});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(POLL_SPAN_MS);
    const order = () => page.locator('#vehicles .vehicle').evaluateAll(rs => rs.map(r => r.dataset.id).join(','));
    const nodataCount = () => page.locator('[data-filter=nodata]').textContent().catch(() => '');
    const bannerText = () => page.locator('#attention .attention-text, #attention').first().evaluate(b => (b.querySelector('.attention-text') ?? b).textContent);
    const before = {order: await order(), nodata: await nodataCount(), attention: await bannerText()};
    await page.locator('#vehicles .vehicle[data-id="900022"]').click();
    setSnapshot(RUN('run-W14H-0001'), [held(w), held(n), z]);
    state.route = {900021: routeOf(held(w)), 900022: routeOf(held(n)), 900023: routeOf(z)};
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    const rowW = await page.locator('#vehicles .vehicle[data-id="900021"]').textContent();
    const rowN = await page.locator('#vehicles .vehicle[data-id="900022"]').textContent();
    check(await page.locator('#vehicles .vehicle[data-id="900021"]').getAttribute('data-level') === 'warning' && rowW.includes('+3:20') && rowW.includes('обновляется')
      && await page.locator('#vehicles .vehicle[data-id="900022"]').getAttribute('data-level') === 'normal' && rowN.includes('+0:40')
      && !/нет прогноза|устарел/i.test(rowW + rowN), `held forecast: same level and value, «обновляется», no «нет прогноза» (${rowW.replace(/\s+/g, ' ')} | ${rowN.replace(/\s+/g, ' ')})`);
    check(await page.locator('.toast').count() === 0 && (await bannerText()) === before.attention && await nodataCount() === before.nodata,
    'held forecast: no toast, banner and «Нет прогноза» count unchanged');
    check((await order()).split(',').filter(id => id !== '900022').join(',') === before.order.split(',').filter(id => id !== '900022').join(','), 'held forecast: the list does not re-sort');
    const headline = norm(await page.locator('#card .forecast').innerText());
    check(await page.locator('#card').getAttribute('data-level') === 'normal' && headline.includes('+40 с') && headline.includes('Прогноз для неё считается') && headline.includes('К новой цели не относится')
      && await page.locator('#prediction-updating').isVisible() && !/устарел|Нет прогноза/.test(headline)
      && (await page.locator('.stops li[data-group=target]').textContent()).includes('прошлый результат модели'),
    `held forecast card: new target «считается», the previous result apart «к новой цели не относится» (C3) (${headline.replace(/\s+/g, ' ')})`);
    check((await page.locator('.vehicle-label[data-id="900021"]').textContent()) === '900021 · опозд. +3:20', 'held forecast: map label keeps the value (C5)');
    await shot(page, 'regression-w14-held-forecast-1920.png');
    // 'none' (the hold expired, no forecast for the new target yet): only then «нет прогноза».
    setSnapshot(RUN('run-W14H-0001'), [{...held(w), prediction_state: 'none', prediction_s: null, status: 'degraded', reason: 'prediction_pending',
      prediction_updating: false, target_stop_id: `N900021`}, held(n), z]);
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    check(await page.locator('#vehicles .vehicle[data-id="900021"]').getAttribute('data-level') === 'nodata'
      && (await page.locator('#vehicles .vehicle[data-id="900021"]').textContent()).includes('Обновляется'), 'prediction_state none: no forecast (grey), reason pending → «Обновляется»');
    // User decision: vehicles without a forecast are calm — no banner count, no alarm level.
    setSnapshot(RUN('run-W14H-0001'), [n, z].map(v => ({...v, status: 'unavailable', reason: 'no_target_in_horizon', prediction_s: null, route_not_started: true}))
      .concat([{...w, status: 'degraded', reason: 'ml_unreachable_or_timeout', prediction_s: null}]));
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    const calmBanner = await page.locator('#attention').textContent();
    const calmRows = await page.locator('#vehicles .vehicle').allInnerTexts();
    check(calmBanner === 'Предупреждений нет' && await page.locator('#attention').getAttribute('data-level') === 'normal'
      && calmRows.some(t => t.includes('Прогноз появится, когда ТС выйдет на маршрут')) && calmRows.some(t => t.includes('Прогноза пока нет'))
      && !calmRows.some(t => /нет прогноза/.test(t)) && await page.locator('.toast').count() === 0,
    `no forecast is calm: banner «Предупреждений нет» without a count, rows by cause (${calmRows.map(t => t.replace(/\s+/g, ' ')).join(' | ')})`);
    await shot(page, 'regression-w14-no-forecast-calm-1920.png');
    await page.close();
  }

  // v2 reaction queue: «События» tab with groups, attention bar with SLA, toast «Новое событие»,
  // take / snooze / close with a reason, reaction steps, hotkeys, bulk actions, GPS mark, dimming.
  {
    const a = bus('900031', center[0], center[1], {prediction_s: 40});
    const b = bus('900032', center[0] + 0.02, center[1] + 0.01, {prediction_s: 30});
    const c = bus('900033', center[0] - 0.02, center[1] - 0.01, {prediction_s: 20});
    const d = bus('900034', center[0] + 0.01, center[1] - 0.015, {prediction_s: null, status: 'unavailable', reason: 'no_target_in_horizon'});
    const e = bus('900035', center[0] - 0.012, center[1] + 0.014, {prediction_s: 60, gps_suspect: 'jump', gps_suspect_text: 'резкий скачок позиции'});
    setSnapshot(RUN('run-V2-0001'), [a, b, c, d, e]);
    state.routes = null;
    state.route = Object.fromEntries([a, b, c, e].map(v => [v.tr_id, routeOf(v)]));
    const page = await open({setup, allow: /\/api\/route\//, tab: 'events'});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(POLL_SPAN_MS);
    check(await page.locator('#events-panel').isVisible() && (await page.locator('#events-list').textContent()).includes('Требуют реакции · 0')
      && (await page.locator('#attention').textContent()) === 'Предупреждений нет', 'queue tab without events: «Требуют реакции · 0», calm bar');
    // Three delays open after the first snapshot: new events, a toast «Новое событие» with SLA.
    setSnapshot(RUN('run-V2-0001'), [{...a, prediction_s: 330}, {...b, prediction_s: 200}, {...c, prediction_s: 150}, d, e]);
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    const needs = page.locator('#events-list .event[data-group=needs]');
    const toast = page.locator('.toast').first();
    check(await needs.count() === 3 && (await needs.first().textContent()).includes('на реакцию') && await page.locator('.toast').count() <= 2
      && (await toast.textContent()).includes('Новое событие') && (await toast.textContent()).includes('на реакцию') && await toast.locator('.toast-take').count() === 1,
    `3 new events in «Требуют реакции» with SLA; toast «Новое событие · … на реакцию» with «Взять» (${(await toast.textContent()).replace(/\s+/g, ' ')})`);
    const bar = await page.locator('#attention').textContent();
    check(bar.includes('Требует реакции') && bar.includes('ТС 900031') && bar.includes('на реакцию') && bar.includes('ещё 2 →')
      && await page.locator('#attention').getAttribute('data-level') === 'severe', `attention bar: the most urgent event, SLA, «Показать», «Взять в работу», «ещё 2 →» (${bar.replace(/\s+/g, ' ')})`);
    // Take from the bar: the event moves to «В работе», the bar moves on.
    await page.locator('#attention [data-action=take-event]').click();
    await page.waitForTimeout(300);
    check(await page.locator('#events-list .event[data-group=work]').count() === 1 && !(await page.locator('#attention').textContent()).includes('ТС 900031'),
      'attention «Взять в работу»: the event is «В работе», the bar shows the next one');
    // J opens the first event of the queue order; S snoozes it 5 min (data time).
    await page.locator('body').click({position: {x: 700, y: 600}}).catch(() => {});
    await page.keyboard.press('Escape');
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(500);
    const jId = await cardTitle(page);
    check(['900032', '900033'].includes(jId), `J opens the next event's vehicle (${jId})`);
    await page.keyboard.press('KeyS');
    await page.waitForTimeout(300);
    const snoozed = page.locator('#events-list .event[data-group=snoozed]');
    check(await snoozed.count() === 1 && /напомнить \d\d:\d\d:\d\d/.test(await snoozed.textContent()) && (await incidentText(page)).includes('Отложено на 5 мин'),
      'S: snoozed 5 min, «напомнить HH:MM:SS», history «Отложено на 5 мин»');
    // Reaction steps and a close with a reason on the other event.
    const other = jId === '900032' ? '900033' : '900032';
    await page.locator(`#events-list .event[data-group=needs]`).first().click();
    await page.waitForTimeout(500);
    check(await cardTitle(page) === other && (await page.locator('#steps-progress').textContent()) === '0/3', `the event card has «Шаги реакции 0/3» (${other})`);
    await openSection(page, 'steps');
    await page.locator('#steps .step[data-step=driver] input').check();
    await page.waitForTimeout(200);
    check((await page.locator('#steps-progress').textContent()) === '1/3' && (await incidentText(page)).includes('Шаг: Связаться с водителем'), 'a step ticks and goes to the history');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(200);
    check(await page.locator('#close-menu').isVisible() && (await page.locator('#close-menu').textContent()).includes('Пробка — повлиять нельзя'), 'C opens the close reasons');
    await page.locator('#close-menu button', {hasText: 'Пробка — повлиять нельзя'}).click();
    await page.waitForTimeout(300);
    check((await incidentText(page)).includes('Закрыто: Пробка — повлиять нельзя') && await page.locator('#events-list .event[data-group=needs]').count() === 0
      && (await page.locator('#events-list').textContent()).includes('Завершены'), 'close with a reason: history «Закрыто: …», the event leaves «Требуют реакции» for «Завершены»');
    await shot(page, 'regression-v2-queue-card-1920.png');
    // Bulk: select all in «В работе» + «Отложены»? — select the snoozed and the work one, close both.
    for (const item of await page.locator('#events-list .event[data-group=work] .event-check, #events-list .event[data-group=snoozed] .event-check').all()) await item.check();
    await page.waitForTimeout(200);
    check(await page.locator('#events-bulk').isVisible() && (await page.locator('#events-bulk').textContent()).includes('Выбрано 2'), 'bulk bar «Выбрано 2»');
    await page.locator('#events-bulk [data-action=bulk-menu][data-menu=close]').click();
    await page.locator('#events-bulk [data-action=bulk-close]', {hasText: 'Водитель уведомлён'}).click();
    await page.waitForTimeout(300);
    check(await page.locator('#events-list .event[data-group=work], #events-list .event[data-group=snoozed]').count() === 0 && await page.locator('#events-bulk').isHidden(),
      'bulk close: both events closed, the bar disappears');
    // GPS mark: a quiet suggestion from Backend, the dispatcher marks, the vehicle turns grey «?».
    await page.locator('#tab-vehicles').click();
    await page.locator('#vehicles .vehicle[data-id="900035"]').click();
    await page.waitForTimeout(500);
    check((await page.locator('#gps-suspect').textContent()) === 'Похоже на сбой GPS: резкий скачок позиции', 'gps_suspect: quiet «Похоже на сбой GPS: …» next to the mark');
    await page.locator('#gps-mark').click();
    await page.waitForTimeout(POLL_SPAN_MS);
    check((await page.locator('#vehicles .vehicle[data-id="900035"]').textContent()).includes('GPS неисправен — отмечено диспетчером')
      && (await page.locator('.vehicle-label[data-id="900035"]').getAttribute('data-symbol'))?.includes('|?|')
      && await page.locator('#vehicles .vehicle[data-id="900035"]').getAttribute('data-level') === 'nodata' && (await page.locator('#gps-mark').textContent()) === 'Снять отметку',
    'GPS mark: list says «GPS неисправен — отмечено диспетчером», grey «?» icon, no forecast level');
    await page.locator('#gps-mark').click();
    await page.waitForTimeout(POLL_SPAN_MS);
    check(await page.locator('#vehicles .vehicle[data-id="900035"]').getAttribute('data-level') === 'normal', 'GPS unmark: the vehicle is back to its forecast');
    // «Приглушить без прогноза»: labels of vehicles without a forecast hidden; off shows them.
    await page.locator('#card-close').click();
    const dimmedLabel = () => page.locator('.vehicle-label[data-id="900034"]').evaluate(l => l.classList.contains('is-dimmed'));
    const dimOn = await dimmedLabel();
    await page.locator('#dim-nodata').click();
    await page.waitForTimeout(300);
    check(dimOn && !(await dimmedLabel()) && await page.locator('#dim-nodata').getAttribute('aria-pressed') === 'false', '«Приглушить без прогноза»: on hides grey labels, off shows them');
    check((await page.locator('#hotkeys').textContent()).includes('J / K — следующее / предыдущее событие'), 'hotkeys hint shown');
    // The queue of this run survives a reload of the page (sessionStorage).
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(2 * POLL_SPAN_MS);
    check((await page.locator('#events-list').textContent()).includes('Завершены · 3'), 'after a reload the queue keeps the closed events («Завершены · 3»)');
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
    await page.locator('#attention button').first().click();
    await openSection(page, 'card-history');
    await page.locator('#contact-open').click();
    const draft = await page.locator('#contact-text').inputValue();
    check(draft.includes('900001') && norm(draft).includes('+3 мин 20 с') && await page.locator('#contact-text').getAttribute('readonly') !== null
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
  if (error.skip) skipped.push(`${pass}: pass not run (UI_PASSES)`);
  else failures.push(`${pass}: exception: ${error.message}`);
} finally {
  await browser.close();
}
console.log(JSON.stringify({base, live: {passed: passed.live.length, selected: liveSelected, checks: passed.live}, regression: {passed: passed.regression.length, checks: passed.regression},
  skipped, failures}, null, 1));
if (failures.length) process.exitCode = 1;
