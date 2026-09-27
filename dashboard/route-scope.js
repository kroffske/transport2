// Operator settings: which routes this dispatcher watches. DOM-free and pure.
//
// The data has no route ID; Backend derives `route_key` per assignment from its plan (assignments with
// one set of stops are one route) and names it by its ends (`route_label`). A vehicle without an
// assignment in the plan has `route_key = null` and falls under NO_ROUTE («Без наряда»).
//
// Settings format (stored as JSON, meant to be issued to an operator later):
//   {"format": "transport.dispatcher-settings.v1", "operator": "Диспетчер", "routes": "all" | ["R-3f2a1c", …]}
// "all" also covers routes that appear later; a list is exactly the routes ticked.

export const SETTINGS_FORMAT = 'transport.dispatcher-settings.v1';
export const NO_ROUTE = 'none';
export const NO_ROUTE_LABEL = 'Без наряда';

export const defaultSettings = () => ({format: SETTINGS_FORMAT, operator: 'Диспетчер', routes: 'all'});

// Settings from stored text; anything that is not this format gives null (the caller falls back).
export function parseSettings(text) {
  try {
    const value = JSON.parse(text);
    const routes = value?.routes === 'all' ? 'all'
      : Array.isArray(value?.routes) && value.routes.every(key => typeof key === 'string') ? [...new Set(value.routes)] : null;
    if (value?.format !== SETTINGS_FORMAT || routes === null) return null;
    return {format: SETTINGS_FORMAT, operator: typeof value.operator === 'string' ? value.operator : 'Диспетчер', routes};
  } catch {
    return null;
  }
}

export const routeOf = row => (row?.route_key ? String(row.route_key) : NO_ROUTE);
export const watches = (settings, key) => settings.routes === 'all' || settings.routes.includes(key);
export const inScope = (settings, row) => watches(settings, routeOf(row));

// The choice list: every route of the plan (Backend catalog) plus any route seen only in the snapshot,
// with the run's vehicles on it; «Без наряда» only while such vehicles exist. Sorted by label.
export function routeChoices(catalog, rows) {
  const choices = new Map();
  const add = (key, label) => {
    if (!choices.has(key)) choices.set(key, {key, label, vehicles: []});
    return choices.get(key);
  };
  for (const route of Array.isArray(catalog) ? catalog : []) if (route?.route_key) add(String(route.route_key), route.route_label ?? '—');
  for (const row of rows) {
    const key = routeOf(row);
    add(key, key === NO_ROUTE ? NO_ROUTE_LABEL : row.route_label ?? '—').vehicles.push(String(row.tr_id));
  }
  const last = key => (key === NO_ROUTE ? 1 : 0);
  return [...choices.values()].sort((a, b) => last(a.key) - last(b.key) || a.label.localeCompare(b.label, 'ru') || a.key.localeCompare(b.key));
}

// Tick or untick one route. Ticking the last missing one of `allKeys` turns the list back into "all".
export function toggleRoute(settings, key, allKeys) {
  const ticked = settings.routes === 'all' ? new Set(allKeys) : new Set(settings.routes);
  if (ticked.has(key)) ticked.delete(key); else ticked.add(key);
  const routes = allKeys.every(k => ticked.has(k)) ? 'all' : allKeys.filter(k => ticked.has(k));
  return {...settings, routes};
}

export const setAll = (settings, on) => ({...settings, routes: on ? 'all' : []});

// Header text: «все» or «N из M» over the routes on the list.
export function scopeSummary(settings, allKeys) {
  if (settings.routes === 'all') return 'все';
  return `${allKeys.filter(key => settings.routes.includes(key)).length} из ${allKeys.length}`;
}
