import test from 'node:test';
import assert from 'node:assert/strict';
import {NO_ROUTE, SETTINGS_FORMAT, defaultSettings, inScope, parseSettings, routeChoices, scopeSummary, setAll, toggleRoute} from './route-scope.js';

const catalog = [
  {route_key: 'R-bbbbbb', route_label: 'Каширское ш. — Борисовский пр.', tr_ids: ['1', '2']},
  {route_key: 'R-aaaaaa', route_label: 'Алма-Атинская ул. — Ереванская ул.', tr_ids: ['3']},
  {route_key: 'R-cccccc', route_label: 'Мясницкая ул.', tr_ids: ['4']},
];
const rows = [
  {tr_id: 1, route_key: 'R-bbbbbb', route_label: 'Каширское ш. — Борисовский пр.'},
  {tr_id: 2, route_key: 'R-bbbbbb', route_label: 'Каширское ш. — Борисовский пр.'},
  {tr_id: 3, route_key: 'R-aaaaaa', route_label: 'Алма-Атинская ул. — Ереванская ул.'},
  {tr_id: 9, route_key: null, route_label: null},
];
const keys = routeChoices(catalog, rows).map(r => r.key);

test('choices: all plan routes by label, run vehicles on them, «Без наряда» last', () => {
  const choices = routeChoices(catalog, rows);
  assert.deepEqual(choices.map(c => [c.key, c.vehicles]), [
    ['R-aaaaaa', ['3']], ['R-bbbbbb', ['1', '2']], ['R-cccccc', []], [NO_ROUTE, ['9']]]);
  assert.equal(choices.at(-1).label, 'Без наряда');
  assert.equal(routeChoices(catalog, rows.slice(0, 3)).some(c => c.key === NO_ROUTE), false);
});

test('scope filters vehicles by their route, not by vehicle', () => {
  let settings = defaultSettings();
  assert.equal(rows.every(row => inScope(settings, row)), true);
  settings = toggleRoute(settings, 'R-bbbbbb', keys);
  assert.deepEqual(settings.routes, ['R-aaaaaa', 'R-cccccc', NO_ROUTE]);
  assert.deepEqual(rows.filter(row => inScope(settings, row)).map(r => r.tr_id), [3, 9]);
  assert.equal(scopeSummary(settings, keys), '3 из 4');
  // Ticking it back gives "all" again, so later routes are watched too.
  assert.equal(toggleRoute(settings, 'R-bbbbbb', keys).routes, 'all');
  assert.equal(scopeSummary(setAll(settings, true), keys), 'все');
  assert.deepEqual(rows.filter(row => inScope(setAll(settings, false), row)), []);
});

test('settings format: round trip, junk and wrong format are rejected', () => {
  const settings = {format: SETTINGS_FORMAT, operator: 'Смена 2', routes: ['R-aaaaaa', 'R-aaaaaa']};
  assert.deepEqual(parseSettings(JSON.stringify(settings)), {...settings, routes: ['R-aaaaaa']});
  assert.deepEqual(parseSettings(JSON.stringify(defaultSettings())), defaultSettings());
  assert.equal(parseSettings('{'), null);
  assert.equal(parseSettings(JSON.stringify({format: 'other', routes: 'all'})), null);
  assert.equal(parseSettings(JSON.stringify({format: SETTINGS_FORMAT, routes: [1]})), null);
});
