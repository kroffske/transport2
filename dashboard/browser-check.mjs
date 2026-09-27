import {chromium} from 'playwright';
import fs from 'node:fs';
const base = process.env.UI_URL || 'http://127.0.0.1:18882';
const evidence = process.env.UI_SCREENSHOT;
const browser = await chromium.launch({headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1});
const failures = [];
page.on('pageerror', e => failures.push(e.message));
page.on('request', req => {if (!req.url().startsWith(base) && !req.url().startsWith('data:')) failures.push(`Внешний запрос: ${req.url()}`);});
const vehicle = {tr_id: '131672', unit_id: 123, lon: 37.6173, lat: 55.7558, location_valid: true,
  status: 'normal', reason: null, gps_age_s: 5, target_stop_id: '53700172828', target_time_begin: '2026-01-06T03:50:00',
  prediction_s: 360, cur_dev_s: 95, last_success_at: '2026-01-06T03:35:00', prediction_age_s: 3};
let revision = 12, offline = false;
await page.route('**/api/snapshot', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({
  status: offline ? 'offline' : 'online', reason: offline ? 'Backend HTTP 503' : null, age_s: offline ? 7 : 0,
  fetched_at: '2026-09-26T18:00:00Z', snapshot: {revision, source_clock: 'simulation', clock_time: '2026-01-06T03:35:00',
    scenario_label: 'синтетический сценарий на исторической модели', vehicles: [vehicle]}})}));
try {
  await page.goto(base, {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.waitForFunction(() => document.getElementById('revision').textContent === '12');
  await page.waitForTimeout(1200); // Give the custom layer its first rendered frame.
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.getByText('6.0 мин', {exact: true}).waitFor();
  const initial = await page.locator('.maplibregl-canvas').screenshot();
  await page.locator('#map').hover(); await page.mouse.wheel(0, -320);
  await page.waitForTimeout(700);
  const zoom = await page.locator('.maplibregl-canvas').screenshot();
  if (Buffer.compare(initial, zoom) === 0) failures.push('Масштабирование не изменило карту');
  await page.mouse.move(640, 420); await page.mouse.down(); await page.mouse.move(760, 480, {steps: 5}); await page.mouse.up();
  revision = 13; vehicle.prediction_s = null; vehicle.status = 'unavailable'; vehicle.reason = 'insufficient_stop_data';
  await page.waitForFunction(() => document.getElementById('revision').textContent === '13', null, {timeout: 5000});
  await page.getByText('Недостаточно данных для прогноза').waitFor();
  offline = true; vehicle.prediction_s = 360; vehicle.status = 'degraded';
  await page.waitForFunction(() => document.getElementById('connection').textContent.includes('недоступен'), null, {timeout: 5000});
  await page.getByText(/последний известный, устарел/).waitFor();
  if (evidence) {fs.mkdirSync(new URL('.', `file://${evidence}`).pathname, {recursive: true}); await page.screenshot({path: evidence, fullPage: true});}
  console.log(JSON.stringify({revision: await page.locator('#revision').textContent(), map: await page.locator('#map-state').textContent(), errors: failures}));
  if (failures.length) process.exitCode = 1;
} finally {await browser.close();}
