// Browser check of the served dispatcher screen (consumer + built bundle + real PMTiles).
// Demo, scenario-run, M1 main-path, rehearsal and viewport passes use no interception. The live-state pass replaces only
// /api/snapshot; the map-unavailable pass replaces only /map/moscow.pmtiles with a 404. The clipboard-unavailable
// check removes navigator.clipboard, as on a plain-http LAN address. UI_RECORD=1 with UI_EVIDENCE_DIR also records
// a paced backup video of the demo story (d06-backup-recording.webm).
import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {labelOffset} from './map-labels.js';

const base = process.env.UI_URL || 'http://127.0.0.1:18882';
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const failures = [];
const passed = [];
const check = (condition, label) => { (condition ? passed : failures).push(label); };
if (evidenceDir) fs.mkdirSync(evidenceDir, {recursive: true});
const shot = async (page, name) => { if (evidenceDir) await page.screenshot({path: path.join(evidenceDir, name)}); };

const browser = await chromium.launch({headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader']});
async function open(viewport, url, {allowConsoleErrors = false, setup, context: contextOptions} = {}) {
  const page = contextOptions
    ? await (await browser.newContext({viewport, deviceScaleFactor: 1, ...contextOptions})).newPage()
    : await browser.newPage({viewport, deviceScaleFactor: 1});
  page.on('pageerror', e => failures.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !allowConsoleErrors) failures.push(`console: ${m.text()}`); });
  page.on('request', req => { if (!req.url().startsWith(base) && !/^(data|blob):/.test(req.url())) failures.push(`external request: ${req.url()}`); });
  // An error status (e.g. the browser's automatic /favicon.ico) is a failure unless the pass provokes errors on purpose.
  page.on('response', res => { if (res.status() >= 400 && !allowConsoleErrors) failures.push(`HTTP ${res.status()}: ${res.url()}`); });
  if (setup) await setup(page);
  await page.goto(`${base}${url}`, {waitUntil: 'domcontentloaded', timeout: 30000});
  return page;
}
const inside = (box, area) => box && box.x >= area.x - 1 && box.y >= area.y - 1
  && box.x + box.width <= area.x + area.width + 1 && box.y + box.height <= area.y + area.height + 1;
const labelPoint = async (page, id) => {
  // A label sits on the free side of its Three.js dot named by data-placement (see map-labels.js).
  const label = page.locator(`.vehicle-label[data-id="${id}"]`);
  const box = await label.boundingBox();
  const [dx, dy] = labelOffset(await label.getAttribute('data-placement'), box.width, box.height);
  return {x: box.x + box.width / 2 - dx, y: box.y + box.height / 2 - dy};
};
// Every pair of visible vehicle labels that intersect, as «A/B w×h».
const labelOverlaps = page => page.locator('.vehicle-label').evaluateAll(elements => {
  const boxes = elements.map(el => ({id: el.dataset.id, r: el.getBoundingClientRect()}));
  const found = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].r, b = boxes[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0) found.push(`${boxes[i].id}/${boxes[j].id} ${w}×${h}`);
    }
  }
  return found;
});
const rows = page => page.locator('#vehicles .vehicle');
const cardTitle = page => page.locator('#card h2').textContent();
const incidentText = page => page.locator('#card .incident').textContent();
// A control is usable when the element at its centre is the control itself (nothing drawn over it).
const uncovered = (page, selector) => page.locator(selector).first().evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return r.width > 0 && (hit === el || el.contains(hit));
});
const pause = (page, ms) => page.waitForTimeout(ms);

// One pass of the demo story from a fresh run: Next to the warning → event → card → take into work → note →
// driver-contact prototype → Next to the end. Returns what the screen showed at each step.
async function story(page, {shots = false, pace = 0} = {}) {
  const seen = [];
  const note = async label => seen.push(`${label}: ${(await page.locator('#scenario-phase').textContent())}`);
  await note('start');
  if (shots) await shot(page, 'd06-1-overview-1920.png');
  await pause(page, pace);
  await page.locator('#scenario-next').click();
  await pause(page, pace);
  await page.locator('#scenario-next').click();
  await pause(page, 300);
  seen.push(`toast: ${await page.locator('.toast').count()} ${await page.locator('.toast').first().textContent()}`);
  seen.push(`unread: ${await page.locator('#events-unread').textContent()}`);
  await pause(page, pace);
  await page.locator('#events-toggle').click();
  seen.push(`events: ${(await page.locator('#events-list .event .event-title').allTextContents()).join(' | ')}`);
  await pause(page, pace);
  await page.locator('#events-list .event').first().click();
  await pause(page, 900);
  seen.push(`card: ${await cardTitle(page)} · ${await page.locator('#card .incident-state').textContent()} · ${await page.locator('#card .incident-flow').textContent()}`);
  if (shots) await shot(page, 'd06-2-incident-1920.png');
  await pause(page, pace);
  await page.locator('#incident-action').click();
  await pause(page, pace / 2);
  await page.locator('#note-input').fill('Связались с диспетчером линии');
  await pause(page, pace / 2);
  await page.locator('.note-form button').click();
  await pause(page, pace / 2);
  await page.locator('#contact-open').click();
  seen.push(`handled: ${await page.locator('#card .incident-flow').textContent()} · notes ${await page.locator('.incident-history li[data-kind=note]').count()}`
    + ` · ${await page.locator('.contact b').textContent()} · ${await page.locator('#contact-text').inputValue()}`);
  if (shots) await shot(page, 'd06-3-handling-1920.png');
  await pause(page, pace);
  await page.locator('#contact-close').click();
  await page.locator('#scenario-next').click();
  await pause(page, pace);
  await page.locator('#scenario-next').click();
  await pause(page, 300);
  seen.push(`end: ${await page.locator('#scenario-phase').textContent()} · ${await page.locator('#card .incident').getAttribute('data-state')}`
    + ` · ${await page.locator('#card .incident-flow').textContent()} · toasts ${await page.locator('.toast').count()}`);
  await pause(page, pace);
  await page.locator('#events-toggle').click();
  seen.push(`summary: ${await page.locator('#events-summary').textContent()}`);
  await pause(page, pace);
  await page.locator('#events-close').click();
  return seen;
}

try {
  // 1. Demo scenario at the primary Full HD viewport, no interception.
  {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(800);
    check(await page.locator('#mode-badge').textContent() === 'Демо-сценарий · значения заданы', 'demo: persistent mode label');
    check((await page.locator('link[rel=icon]').getAttribute('href')).startsWith('data:image/svg+xml,'), 'demo: inline page icon, no /favicon.ico request');
    check(await rows(page).count() === 8, 'demo: 8 objects listed');
    check(await page.locator('.vehicle-label').count() === 7, 'demo: 7 located objects labelled on map (1 without GPS)');
    check((await page.locator('[data-filter]').allTextContents()).join('|') === 'Все 8|С предупреждениями 1|Нет данных 2', 'demo: filter counters');
    check((await page.locator('#attention').textContent()).includes('Д-103'), 'demo: problem object named in attention banner');
    check((await page.locator('#routes [data-route]').allTextContents()).join('|') === 'Все направления 8|Напр. А 4|Напр. Б 3|Без привязки 1', 'D03: direction filter with counts and «Без привязки»');
    check((await page.locator('.direction-chip').allTextContents()).join('|') === 'А: А1 → А6|Б: Б1 → Б6', 'D03: both demo directions drawn with their point order');
    check((await page.locator('#legend-note').textContent()).includes('не трасса'), 'D03: legend marks the line as a scheme, not a road trace');
    check(await page.locator('#events-unread').textContent() === '1' && await page.locator('.toast').count() === 0, 'D04: existing event counted as unread, no toast on first snapshot');
    await shot(page, 'demo-overview-1920.png');

    const mapBox = await page.locator('#map-pane').boundingBox();
    const p101 = await labelPoint(page, 'Д-101');
    await page.mouse.move(p101.x, p101.y);
    await page.waitForTimeout(150);
    check(await page.locator('.vehicle[data-id="Д-101"].is-hovered').count() === 1, 'demo: map hover highlights list row');
    await page.mouse.click(p101.x, p101.y);
    check(await cardTitle(page) === 'Д-101', 'demo: map click selects object');
    check(await page.locator('.vehicle[aria-current=true]').getAttribute('data-id') === 'Д-101', 'demo: map selection mirrored in list');

    await rows(page).filter({hasText: 'Д-103'}).click();
    await page.waitForTimeout(900);
    check(await cardTitle(page) === 'Д-103', 'demo: list click selects object');
    const card = await page.locator('#card').textContent();
    check(card.includes('2.8 мин') && card.includes('Значение задано сценарием') && card.includes('не установлена'), 'demo: card shows delay, scenario source, unknown cause');
    check(await page.locator('#model-link').count() === 0 && !card.includes('Результат модели'), 'demo: scenario card claims no model result');
    const selectedLabel = await page.locator('.vehicle-label.is-selected').boundingBox();
    check(inside(selectedLabel, mapBox), 'demo: selected object stays inside the map area, not under the panel');
    await shot(page, 'demo-selected-1920.png');

    const card103 = await page.locator('#card').textContent();
    check(card103.includes('Демо-линия · направление А') && card103.includes('А1 → А2 → А3') && card103.includes('Точка сценария А3 · план 12:45')
      && await page.locator('.target-label').textContent() === 'Цель А3 · план 12:45', 'D03: card names direction and target; target marker labelled from the catalog');
    check(await page.locator('.direction-chip[data-route="demo-line:a"]').getAttribute('data-emphasis') === 'focus'
      && await page.locator('.direction-chip[data-route="demo-line:b"]').getAttribute('data-emphasis') === 'dim', 'D03: selected object highlights its own direction');
    await page.locator('#routes [data-route="demo-line:b"]').click();
    check((await rows(page).allTextContents()).every(t => t.includes('напр. Б')) && await rows(page).count() === 3, 'D03: direction filter shows only that direction');
    await page.locator('#routes [data-route=unmapped]').click();
    await rows(page).first().click();
    check(await cardTitle(page) === 'Д-108' && (await page.locator('#card').textContent()).includes('Без привязки')
      && (await page.locator('#card').textContent()).includes('Цель не определена') && await page.locator('.target-label').count() === 0, 'D03: object without mapping stays «Без привязки», no invented target');
    await page.locator('#routes [data-route=all]').click();
    await page.locator('[data-filter=warning]').click();
    check(await rows(page).count() === 1, 'demo: warning filter');
    await page.locator('[data-filter=nodata]').click();
    check(await rows(page).count() === 2 && (await page.locator('#vehicles').textContent()).includes('без позиции'), 'demo: no-data filter incl. object without GPS');
    await page.locator('[data-filter=all]').click();
    await page.locator('#search').fill('105');
    check(await rows(page).count() === 1, 'demo: search by displayed ID');
    await page.locator('#search').fill('нет-такого');
    check((await page.locator('#vehicles').textContent()).includes('Ничего не найдено'), 'demo: empty search state');
    await page.locator('#search').fill('');
    await page.locator('#clear-selection').click();
    check(await page.locator('#card .card-empty').count() === 1, 'demo: reset selection');
    await page.locator('#overview').click();
    await page.locator('#diagnostics summary').click();
    const diag = await page.locator('#diag-list').textContent();
    check(diag.includes('moscow-center-demo') && diag.includes('PMTiles sha256'), 'demo: diagnostics disclosure');
    await shot(page, 'demo-diagnostics-1920.png');
    await page.close();
  }

  // 1b. Scenario run: Start/Pause/Next/Reset through all phases, three runs, no reload.
  {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    const phase = () => page.locator('#scenario-phase').textContent();
    const state = () => page.locator('#scenario-state').textContent();
    const runId = () => page.locator('#scenario-run').getAttribute('title');
    const counters = async () => (await page.locator('[data-filter]').allTextContents()).join('|');
    const walk = async () => { // Next through every phase, recording what the screen shows.
      const seen = [`${await phase()} ${await counters()}`];
      while (await page.locator('#scenario-next').isEnabled()) {
        await page.locator('#scenario-next').click();
        seen.push(`${await phase()} ${await counters()}`);
      }
      return seen;
    };
    await page.evaluate(() => { window.__sameDocument = true; });
    check(await page.locator('#scenario').isVisible() && await phase() === 'Фаза 1 из 5 · Обзор' && await state() === 'ожидает запуска'
      && await page.locator('#scenario-start').textContent() === 'Начать демо' && await page.locator('#scenario-pause').isDisabled(), 'scenario: run waits at phase 1');
    const firstRun = await runId();
    check(/^moscow-center-demo\.d03\.v\d+\.r1-\w+$/.test(firstRun) && (await page.locator('#data-status').textContent()).includes('Сценарий · фаза 1 из 5'), 'scenario: run ID and phase in status');
    await rows(page).filter({hasText: 'Д-104'}).click();
    await page.locator('#scenario-start').click();
    check(await state() === 'идёт' && await page.locator('#scenario-start').isDisabled(), 'scenario: Start plays');
    await page.waitForFunction(() => document.getElementById('scenario-phase').textContent === 'Фаза 2 из 5 · Прогноз обновляется', null, {timeout: 12000});
    const updating = await page.locator('#card').textContent();
    check(await cardTitle(page) === 'Д-104' && updating.includes('Нет прогноза') && updating.includes('прогноз рассчитывается'), 'scenario: auto-advance keeps selection; "updating" shown by the ordinary card');
    await page.locator('#scenario-pause').click();
    check(await state() === 'пауза' && await page.locator('#scenario-start').textContent() === 'Продолжить', 'scenario: Pause');
    await page.waitForTimeout(9000);
    check(await phase() === 'Фаза 2 из 5 · Прогноз обновляется', 'scenario: paused run does not advance');
    await page.locator('#scenario-next').click();
    await page.waitForTimeout(300);
    const attention = await page.locator('#attention').textContent();
    check(await phase() === 'Фаза 3 из 5 · Новое предупреждение' && attention.includes('Новое предупреждение') && attention.includes('Д-104')
      && (await rows(page).filter({hasText: 'Д-104'}).textContent()).includes('Новое · сильная задержка')
      && await page.locator('.vehicle-label[data-id="Д-104"]').getAttribute('data-level') === 'severe', 'scenario: Next → new warning in banner, list and map');
    check((await page.locator('#card').textContent()).includes('Значение задано сценарием') && await page.locator('#mode-badge').textContent() === 'Демо-сценарий · значения заданы', 'scenario: values stay marked as scenario');
    await shot(page, 'scenario-new-warning-1920.png');
    await page.locator('#scenario-next').click();
    check(await phase() === 'Фаза 4 из 5 · Данные недоступны' && (await rows(page).filter({hasText: 'Д-103'}).textContent()).includes('Устройство отключено')
      && (await page.locator('.vehicle-label[data-id="Д-103"]').textContent()).includes('устарел'), 'scenario: data unavailable shown as stale, not a warning');
    await shot(page, 'scenario-data-loss-1920.png');
    await page.locator('#scenario-next').click();
    check(await phase() === 'Фаза 5 из 5 · Возврат в норму' && await state() === 'завершён' && (await page.locator('#attention').textContent()).includes('Предупреждений нет')
      && await page.locator('#scenario-next').isDisabled() && await page.locator('#scenario-start').isDisabled(), 'scenario: last phase returns to normal and stops');
    await page.locator('#diagnostics summary').click();
    const diag = await page.locator('#diag-list').textContent();
    check(diag.includes(firstRun) && diag.includes('overview → updating → new-warning → data-loss → recovery'), 'scenario: diagnostics show run ID and its local history');
    await shot(page, 'scenario-finished-1920.png');
    await page.locator('#diagnostics summary').click();

    await page.locator('[data-filter=nodata]').click();
    await page.locator('#scenario-reset').click();
    const secondRun = await runId();
    const diagAfterReset = await page.evaluate(() => { document.getElementById('diagnostics').open = true; return document.getElementById('diag-list').textContent; });
    check(await page.evaluate(() => window.__sameDocument === true), 'scenario: Reset does not reload the page');
    check(secondRun !== firstRun && /\.r2-/.test(secondRun) && await phase() === 'Фаза 1 из 5 · Обзор' && await state() === 'ожидает запуска', 'scenario: Reset starts a new run at phase 1');
    check(await page.locator('#card .card-empty').count() === 1 && await page.locator('[data-filter=all]').getAttribute('aria-pressed') === 'true'
      && !diagAfterReset.includes(firstRun) && diagAfterReset.includes('История запуска') && !diagAfterReset.includes('→'), 'scenario: Reset carries no selection, filter or history from the previous run');
    await page.evaluate(() => { document.getElementById('diagnostics').open = false; });
    const run2 = await walk();
    await page.locator('#scenario-reset').click();
    const run3 = await walk();
    await page.locator('#scenario-reset').click();
    const run4 = await walk();
    check(run2.length === 5 && JSON.stringify(run3) === JSON.stringify(run2) && JSON.stringify(run4) === JSON.stringify(run2), `scenario: three reset runs show the same phases (${run2.join(' / ')})`);
    check(/\.r4-/.test(await runId()), 'scenario: every reset gets a new run ID');

    // Leaving the scenario stops it: an in-flight step never brings the scenario back.
    await page.locator('#scenario-reset').click();
    await page.locator('#scenario-start').click();
    await page.locator('[data-mode=live]').click();
    await page.waitForTimeout(9000);
    check(await page.locator('#mode-badge').textContent() === 'Поток Backend · телеметрия NDTP' && await page.locator('#scenario').isHidden()
      && !(await page.locator('#data-status').textContent()).includes('Сценарий'), 'scenario: switching to live stops the scenario timer');
    await page.locator('[data-mode=demo]').click();
    check(/\.r6-/.test(await runId()) && await phase() === 'Фаза 1 из 5 · Обзор', 'scenario: returning to demo starts a new run');
    await page.close();
  }

  // 1c. M1 main path at 1920×1080, no interception:
  // overview → Start → warning → Events → direction/object → card → acknowledge → note → return to normal/history.
  {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(600);
    const phase = () => page.locator('#scenario-phase').textContent();
    const incident = () => page.locator('#card .incident');
    await shot(page, 'm1-1-overview-1920.png');
    await page.locator('#scenario-start').click();
    await page.waitForFunction(() => document.getElementById('scenario-phase').textContent.startsWith('Фаза 3 из 5'), null, {timeout: 20000});
    await page.locator('#scenario-pause').click();
    await page.waitForTimeout(300);
    const toast = page.locator('.toast');
    check(await toast.count() === 1 && (await toast.textContent()).includes('Новое событие №2') && (await toast.textContent()).includes('направление Б')
      && (await toast.textContent()).includes('Д-104 6.5 мин · Д-102 3.2 мин'), 'M1: one toast for the new direction-Б episode, both objects grouped');
    check(await page.locator('#events-unread').textContent() === '2', 'M1: unread counter shows the new and the existing event');
    await shot(page, 'm1-2-warning-toast-1920.png');
    await page.locator('#events-toggle').click();
    const events = page.locator('#events-list .event');
    check(await events.count() === 2 && (await events.nth(0).textContent()).includes('направление Б') && (await events.nth(1).textContent()).includes('направление А')
      && await events.nth(0).getAttribute('data-unread') === 'true', 'M1: event centre lists the two directions separately, newest first');
    await shot(page, 'm1-3-events-1920.png');
    await events.nth(0).click();
    await page.waitForTimeout(900);
    check(await page.locator('#events-panel').isHidden() && await page.locator('.toast').count() === 0 && await page.locator('#events-unread').textContent() === '1', 'M1: opening the event reads it and closes panel and toast');
    check(await page.locator('#routes [data-route="demo-line:b"]').getAttribute('aria-pressed') === 'true' && await cardTitle(page) === 'Д-104'
      && await page.locator('.direction-chip[data-route="demo-line:b"]').getAttribute('data-emphasis') === 'focus', 'M1: event → its direction and its most urgent object');
    check(inside(await page.locator('.vehicle-label.is-selected').boundingBox(), await page.locator('#map-pane').boundingBox()), 'M1: selected object inside the map, not under a panel');
    const eventText = await incident().textContent();
    check(eventText.includes('Событие №2') && eventText.includes('Активно') && eventText.includes('Новое') && eventText.includes('Событие открыто'), 'M1: card shows the event, its state and history');
    check(await page.locator('#incident-action').textContent() === 'Взять в работу', 'M1: primary action is «Взять в работу»');
    await page.locator('#incident-action').click();
    check(await page.locator('#card .incident-flow').textContent() === 'В работе' && await page.locator('#incident-action').textContent() === 'Вернуть в новые'
      && (await incident().textContent()).includes('Взято в работу') && await incident().getAttribute('data-state') === 'active', 'M1: acknowledge changes status, not the delay state');
    await page.locator('#incident-action').click();
    check(await page.locator('#card .incident-flow').textContent() === 'Новое' && (await incident().textContent()).includes('Возвращено в новые'), 'D05: «Вернуть в новые» reopens');
    await page.locator('#incident-action').click();
    const hostile = '<img src=x onerror="window.__xss=1"><b>жирный</b> позвонить водителю';
    await page.locator('#note-input').fill(hostile);
    await page.locator('.note-form button').click();
    const notes = page.locator('.incident-history li[data-kind=note]');
    check(await notes.count() === 1 && (await notes.textContent()).includes(hostile) && await page.locator('#card .incident img, #card .incident-history b').count() === 0
      && await page.evaluate(() => window.__xss === undefined), 'M1: note stored and shown as plain text; HTML not executed');
    await page.locator('#note-input').fill('   ');
    await page.locator('.note-form button').click();
    check(await notes.count() === 1, 'D05: empty note rejected');
    await shot(page, 'm1-4-card-acknowledged-1920.png');
    await page.locator('#scenario-start').click(); // continue: phases 4 and 5 play automatically
    await page.waitForFunction(() => document.getElementById('scenario-phase').textContent.startsWith('Фаза 4 из 5'), null, {timeout: 12000});
    check(await page.locator('#card .incident-flow').textContent() === 'В работе' && await notes.count() === 1, 'M1: acknowledgement and note survive the next snapshot');
    await page.waitForFunction(() => document.getElementById('scenario-phase').textContent.startsWith('Фаза 5 из 5'), null, {timeout: 12000});
    await page.waitForTimeout(300);
    const ended = await incident().textContent();
    check(await incident().getAttribute('data-state') === 'resolved' && ended.includes('Задержка закончилась') && ended.includes('В работе')
      && await page.locator('#incident-action').count() === 0 && await notes.count() === 1, 'M1: return to normal ends the episode; history keeps action and note');
    check(await page.locator('.toast').count() === 0, 'D04: no further toasts while the same episodes continue or end');
    await shot(page, 'm1-5-history-1920.png');
    await page.locator('#events-toggle').click();
    check((await page.locator('#events-summary').textContent()).includes('закончились 2'), 'D04: both episodes ended, none duplicated');
    await page.locator('#events-list .event[data-id$="demo-line:a#1"]').click();
    const lostHistory = await incident().textContent();
    check(await cardTitle(page) === 'Д-103' && lostHistory.includes('Мониторинг потерян') && lostHistory.includes('Задержка закончилась'), 'D04: data loss was monitoring_lost before the resolution');
    await page.locator('#scenario-reset').click();
    await page.locator('#events-toggle').click();
    const afterReset = await page.locator('#events-list').textContent();
    check(await page.locator('#events-list .event').count() === 1 && !afterReset.includes('В работе') && !afterReset.includes('заметок')
      && afterReset.includes('№1'), 'M1: Reset carries no event or action history into the new run');
    await page.close();
  }

  // 1d. D06 rehearsal at 1920×1080, no interception: the story three times in a row, Reset between runs.
  {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__sameDocument = true; });
    const runs = [];
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      if (i) await page.locator('#scenario-reset').click();
      await page.waitForTimeout(600);
      ids.push(await page.locator('#scenario-run').getAttribute('title'));
      runs.push(await story(page, {shots: i === 0}));
      if (i === 0) {
        // Main controls are not covered by the toast, legend, panels or the sticky card actions.
        await page.locator('#scenario-reset').click();
        await page.locator('#scenario-next').click();
        await page.locator('#scenario-next').click();
        await page.locator('#events-toggle').click();
        await page.locator('#events-list .event').first().click();
        await page.waitForTimeout(900);
        for (const selector of ['#mode-badge', '#events-toggle', '#diagnostics summary', '#scenario-start', '#scenario-next', '#scenario-reset', '#overview',
          '#incident-action', '#card-show', '#card-close', '#note-input', '#contact-open', '#routes [data-route="demo-line:b"]']) {
          check(await uncovered(page, selector), `D06: ${selector} is not covered at 1920×1080`);
        }
        check(await page.locator('.vehicle-note').evaluateAll(notes => notes.every(n => n.scrollHeight <= 20)), 'D06: list rows keep their status on one line at 1920×1080');
        await page.locator('#diagnostics summary').click();
        const build = await page.evaluate(async () => (await (await fetch('/api/build', {cache: 'no-store'})).json()).files);
        const diag = await page.locator('#diag-list').textContent();
        check(/^[0-9a-f]{64}$/.test(build['static/app.js']) && diag.includes(build['static/app.js']) && diag.includes(build['static/app.css']),
          'D06: diagnostics show the served bundle hashes (app.js, app.css) from /api/build');
        await page.locator('#diagnostics summary').click();
      }
    }
    check(runs[0].length === 8 && runs.every(r => JSON.stringify(r) === JSON.stringify(runs[0])), `D06: three consecutive runs show the same story (${runs[0].join(' / ')})`);
    check(new Set(ids).size === 3 && await page.evaluate(() => window.__sameDocument === true), 'D06: each repeat is a new run ID without a page reload');
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const targetBox = await page.locator('.target-label').boundingBox();
    const selectedBox = await page.locator('.vehicle-label.is-selected').boundingBox();
    check(await cardTitle(page) === 'Д-104' && targetBox && selectedBox && !overlaps(targetBox, selectedBox),
      'D06: the target name does not cover the selected object\'s label as it nears the target');
    check(runs[0][2] === 'unread: 2' && runs[0][4].startsWith('card: Д-104 · Активно · Новое') && runs[0][5].includes('В работе · notes 1 · Прототип · отправка не подключена')
      && runs[0][6].includes('resolved · В работе · toasts 0'), 'D06: the story reaches warning, card, handling with the prototype marker, and the end state');
    await page.close();
  }

  // 1g. Label readability at 1920×1080, no interception: every phase of three Reset runs, after the map settles.
  {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      await page.locator('#scenario-reset').click();
      const seen = [];
      for (let phase = 1; phase <= 5; phase += 1) {
        if (phase > 1) await page.locator('#scenario-next').click();
        await page.waitForTimeout(900);
        const found = await labelOverlaps(page);
        seen.push(`${phase}:${await page.locator('.vehicle-label').count()}:${found.join(',') || 'none'}`);
      }
      runs.push(seen.join(' '));
    }
    check(runs.every(r => r === runs[0]) && runs[0].split(' ').every(p => p.endsWith(':none')), `labels: no two vehicle labels intersect in any phase of three runs (${runs[0]})`);
    await page.close();
  }

  // 1e. Driver-contact prototype: a copy is reported only when it happened; nothing is ever «sent».
  for (const [label, options] of [
    ['clipboard granted', {context: {permissions: ['clipboard-read', 'clipboard-write']}}],
    ['clipboard unavailable', {setup: page => page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'clipboard', {get: () => undefined}); })}],
  ]) {
    const page = await open({width: 1920, height: 1080}, '/?mode=demo', options);
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.locator('#attention button').click();
    await page.locator('#contact-open').click();
    const draft = await page.locator('#contact-text').inputValue();
    check(draft.includes('Д-103') && draft.includes('2.8 мин') && await page.locator('#contact-text').getAttribute('readonly') !== null
      && (await page.locator('.contact').textContent()).includes('Прототип · отправка не подключена'), `D05 prototype (${label}): marked preview with a prepared text`);
    await page.locator('#contact-copy').click();
    await page.waitForSelector('#contact-result:not([data-result=none])', {timeout: 3000});
    const result = await page.locator('#contact-result').textContent();
    const card = await page.locator('#card').textContent();
    check(!/отправлено|отправлен водителю|доставлено/i.test(card.replace('ещё не отправлен', '').replace('Ничего не отправлено', '')), `D05 prototype (${label}): never claims a sent message`);
    if (label === 'clipboard granted') {
      check(await page.locator('#contact-result').getAttribute('data-result') === 'copied' && result.includes('скопирован')
        && await page.evaluate(() => navigator.clipboard.readText()) === draft, 'D05 prototype: copy reported only after the text is in the clipboard');
    } else {
      check(await page.locator('#contact-result').getAttribute('data-result') === 'manual' && result.includes('скопируйте его вручную') && !result.includes('Текст скопирован')
        && await page.evaluate(() => document.activeElement?.id === 'contact-text' && getSelection().toString().length > 0 || document.activeElement.selectionEnd > 0),
      'D05 prototype: without a clipboard the text is selected for manual copy, no false success');
    }
    await page.locator('#contact-close').click();
    check(await page.locator('.contact').count() === 0 && await page.locator('#contact-open').count() === 1, `D05 prototype (${label}): closes back to the card`);
    await page.close();
  }

  // 1f. Optional paced backup recording of the story (evidence only, no checks).
  if (evidenceDir && process.env.UI_RECORD === '1') {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'd06-video-'));
    const context = await browser.newContext({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1, recordVideo: {dir, size: {width: 1920, height: 1080}}});
    const page = await context.newPage();
    page.on('pageerror', e => failures.push(`pageerror (recording): ${e.message}`));
    await page.goto(`${base}/?mode=demo`, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.waitForTimeout(3000);
    await story(page, {pace: 4000});
    await page.waitForTimeout(3000);
    const video = page.video();
    await context.close();
    fs.copyFileSync(await video.path(), path.join(evidenceDir, 'd06-backup-recording.webm'));
    fs.rmSync(dir, {recursive: true, force: true});
  }

  // 2. Live source states; only /api/snapshot is replaced.
  {
    const vehicle = {tr_id: '131672', unit_id: 123, lon: 37.6173, lat: 55.7558, location_valid: true,
      status: 'normal', reason: null, gps_age_s: 5, target_stop_id: '53700172828', target_time_begin: '2026-01-06T03:50:00',
      prediction_s: 360, cur_dev_s: 95, prediction_age_s: 3, model_version: 'canonical_rmse_d8',
      artifact_sha256: 'dc33437108c3e036089450c9b98771dacd014246fbb91d0df2a89d0c8e247122',
      prediction_input_frame_id: 'abc:12:11', prediction_context_revision: 7, last_success_at: '2026-01-06T03:34:40'};
    let first = true, neverOnline = true, offline = false, vehicles = [vehicle];
    const setup = page => page.route('**/api/snapshot', async route => {
      if (first) { first = false; await new Promise(r => setTimeout(r, 1500)); }
      if (neverOnline) {
        await route.fulfill({contentType: 'application/json', body: JSON.stringify({status: 'offline', reason: 'Backend HTTP 503',
          age_s: null, fetched_at: null, checked_at: '2026-09-27T12:00:00Z', snapshot: null})});
        return;
      }
      await route.fulfill({contentType: 'application/json', body: JSON.stringify({
        status: offline ? 'offline' : 'online', reason: offline ? 'Backend HTTP 503' : null, age_s: offline ? 7 : 0,
        fetched_at: '2026-09-27T12:00:00Z', checked_at: '2026-09-27T12:00:00Z',
        snapshot: {revision: 12, source_clock: 'dataset_wall', clock_time: '2026-01-06T03:35:00', vehicles}})});
    });
    const page = await open({width: 1920, height: 1080}, '/?mode=live', {setup});
    await page.waitForFunction(() => document.getElementById('vehicles').textContent.includes('Загрузка снимка Backend'));
    check((await page.locator('#data-status').textContent()).includes('Ожидание ответа Backend'), 'live: loading state');
    await page.waitForFunction(() => document.getElementById('data-status').textContent.includes('Backend недоступен · данных нет'), null, {timeout: 5000});
    check((await page.locator('#vehicles').textContent()).includes('Данные не подставляются') && await rows(page).count() === 0
      && await page.locator('#mode-badge').textContent() === 'Поток Backend · телеметрия NDTP' && await page.locator('#scenario').isHidden(), 'live: Backend down before first snapshot shows no data, no scenario');
    await shot(page, 'live-no-data-1920.png');
    neverOnline = false;
    await page.waitForFunction(() => document.getElementById('data-status').textContent.includes('Backend online'), null, {timeout: 8000});
    check(await page.locator('#mode-badge').textContent() === 'Поток Backend · телеметрия NDTP', 'live: persistent mode label');
    await rows(page).first().click();
    const card = await page.locator('#card').textContent();
    check(card.includes('6.0 мин') && card.includes('Прогноз Backend · модель canonical_rmse_d8'), 'live: card shows Backend prediction and model');
    check(await page.locator('#model-link').getAttribute('data-frame') === 'abc:12:11' && card.includes('кадр NDTP abc:12:11 · контекст №7')
      && card.includes('артефакт dc33437108c3'), 'live: card links the result to its NDTP input frame, context and model artifact');
    check(card.includes('Без привязки') && card.includes('Плановая точка 53700172828') && card.includes('не код остановки')
      && await page.locator('.target-label').count() === 0 && await page.locator('.direction-chip').count() === 0, 'live: no route mapping → «Без привязки», no target marker, no scheme');
    check(await page.locator('.toast').count() === 0 && (await incidentText(page)).includes('Активно'), 'live: warning opens an event (no toast for the first snapshot)');
    await page.locator('#incident-action').click();
    await page.locator('#note-input').fill('проверить связь');
    await page.locator('.note-form button').click();
    const historyBefore = await page.locator('.incident-history li').count();
    await page.locator('#note-input').fill('черновик');
    await page.waitForTimeout(4000); // ≥ 2 polls of the same snapshot
    check(await page.locator('#note-input').inputValue() === 'черновик' && await page.evaluate(() => document.activeElement?.id === 'note-input'), 'live: a note being typed survives polling');
    check(await page.locator('#card .incident-flow').textContent() === 'В работе' && await page.locator('.incident-history li').count() === historyBefore
      && (await page.locator('#events-toggle').getAttribute('title')).includes('активных 1 ') && await page.locator('.toast').count() === 0, 'live: acknowledgement and note survive polling without duplicate events');
    vehicle.prediction_s = null; vehicle.status = 'unavailable'; vehicle.reason = 'insufficient_stop_data';
    await page.waitForFunction(() => document.getElementById('card').textContent.includes('Нет прогноза'), null, {timeout: 5000});
    check(true, 'live: missing prediction shown as "Нет прогноза"');
    check(await page.locator('#card .incident').getAttribute('data-state') === 'monitoring_lost', 'live: lost prediction → monitoring_lost, not resolved');
    vehicle.prediction_s = 360; vehicle.status = 'normal'; vehicle.reason = null; offline = true;
    await page.waitForFunction(() => document.getElementById('data-status').textContent.includes('Backend недоступен · последний снимок'), null, {timeout: 5000});
    check(await page.locator('#mode-badge').textContent() === 'Поток Backend · телеметрия NDTP' && await page.locator('#scenario').isHidden()
      && !(await page.locator('#card').textContent()).includes('сценари'), 'live: Backend loss keeps live label, no scenario fallback');
    check((await page.locator('#attention').textContent()).includes('Backend недоступен') && (await page.locator('#card').textContent()).includes('устарел'), 'live: offline shows last-known values as stale');
    check(await page.locator('#card .incident').getAttribute('data-state') === 'monitoring_lost' && !(await incidentText(page)).includes('Задержка закончилась'), 'live: offline is monitoring_lost, never a resolution');
    await shot(page, 'live-offline-1920.png');
    offline = false; vehicles = [];
    await page.waitForFunction(() => document.getElementById('vehicles').textContent.includes('В снимке нет машин'), null, {timeout: 5000});
    check(true, 'live: empty snapshot state');
    vehicles = [{...vehicle, prediction_s: 60}];
    await page.waitForFunction(() => document.getElementById('vehicles').textContent.includes('131672'), null, {timeout: 5000});
    await rows(page).first().click();
    check(await page.locator('#card .incident').getAttribute('data-state') === 'resolved' && (await incidentText(page)).includes('В работе')
      && (await incidentText(page)).includes('проверить связь'), 'live: current value ≤ 2 min resolves the same episode; its history is kept');
    await page.close();
  }

  // 3. Map archive missing: explicit error, no points drawn over a missing base map.
  {
    const setup = page => page.route('**/map/moscow.pmtiles', route => route.fulfill({status: 404, body: 'missing'}));
    const page = await open({width: 1920, height: 1080}, '/?mode=demo', {setup, allowConsoleErrors: true});
    await page.waitForSelector('#map-pane[data-state=unavailable]', {timeout: 15000});
    check((await page.locator('#map-state').textContent()).includes('Карта недоступна'), 'map-unavailable: explicit message');
    check(await page.locator('.vehicle-label').count() === 0, 'map-unavailable: no labels over missing map');
    await rows(page).filter({hasText: 'Д-104'}).click();
    check(await cardTitle(page) === 'Д-104' && await page.locator('#card-show').isDisabled(), 'map-unavailable: list and card still work');
    check(await page.locator('.direction-chip, .target-label').count() === 0, 'map-unavailable: no route scheme over missing map');
    await shot(page, 'map-unavailable-1920.png');
    await page.close();
  }

  // 4. Spot-check smaller desktop viewports: main controls stay reachable.
  for (const viewport of [{width: 1440, height: 900}, {width: 1366, height: 768}]) {
    const page = await open(viewport, '/?mode=demo');
    await page.waitForSelector('#map-pane[data-state=ready]', {timeout: 30000});
    await page.locator('#attention button').click();
    await page.waitForTimeout(900);
    const area = {x: 0, y: 0, ...viewport};
    for (const selector of ['#scenario-start', '#scenario-next', '#scenario-reset', '#overview', '#search', '#clear-selection', '[data-filter=warning]', '[data-mode=live]', '#diagnostics summary', '#mode-badge', '#events-toggle', '#routes [data-route="demo-line:a"]', '#incident-action', '#card-show']) {
      check(inside(await page.locator(selector).first().boundingBox(), area), `${viewport.width}x${viewport.height}: ${selector} visible`);
    }
    check(inside(await page.locator('.vehicle-label.is-selected').boundingBox(), await page.locator('#map-pane').boundingBox()), `${viewport.width}x${viewport.height}: selected object inside map`);
    await shot(page, `demo-selected-${viewport.width}.png`);
    await page.close();
  }
} catch (error) {
  failures.push(`exception: ${error.message}`);
} finally {
  await browser.close();
}
console.log(JSON.stringify({base, passed: passed.length, failures, checks: passed}, null, 1));
if (failures.length) process.exitCode = 1;
