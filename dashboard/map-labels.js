// Screen placement of vehicle labels next to their map dots, so no two labels cover each other.
// Pure geometry: the caller measures labels and projects dots; nothing here touches the DOM or the map.
//
// Policy: labels are placed one by one in priority order (selected first, then higher `priority`, then ID). Each label takes
// the first side of its own dot that is free of already placed labels, other dots and fixed map
// labels, and lies inside the map; if every side is taken it is stacked further above or below its dot.
// The result depends only on the input geometry, so the same view always gives the same placement.

export const LABEL_GAP = 14; // dot centre → nearest label edge; the unobstructed label sits above its dot
const DIAGONAL_GAP = 10;
export const LABEL_MARGIN = 4; // clear space between labels; also covers the selected label's outline
export const DOT_RADIUS = 13; // the halo drawn around a dot
export const SELECTED_DOT_RADIUS = 16;

const SIDES = ['top', 'bottom', 'right', 'left', 'top-right', 'top-left', 'bottom-right', 'bottom-left'];

// Offset of the label centre from its dot for a placement name (`top`, `bottom-left`, `top+2`, …).
export function labelOffset(placement, width, height) {
  const [side, level = '0'] = placement.split('+');
  const stack = Number(level) * (height + LABEL_MARGIN);
  const dx = width / 2, dy = height / 2;
  switch (side) {
    case 'top': return [0, -(LABEL_GAP + dy + stack)];
    case 'bottom': return [0, LABEL_GAP + dy + stack];
    case 'right': return [LABEL_GAP + dx, 0];
    case 'left': return [-(LABEL_GAP + dx), 0];
    case 'top-right': return [DIAGONAL_GAP + dx, -(DIAGONAL_GAP + dy)];
    case 'top-left': return [-(DIAGONAL_GAP + dx), -(DIAGONAL_GAP + dy)];
    case 'bottom-right': return [DIAGONAL_GAP + dx, DIAGONAL_GAP + dy];
    case 'bottom-left': return [-(DIAGONAL_GAP + dx), DIAGONAL_GAP + dy];
    default: throw new Error(`unknown label placement ${placement}`);
  }
}

// Candidate placements in order of preference; the stacked ones leave room even in a dense cluster.
function candidates(count) {
  const stacked = [];
  for (let level = 1; level <= count; level += 1) stacked.push(`top+${level}`, `bottom+${level}`);
  return [...SIDES, ...stacked];
}

const rectAt = (x, y, [dx, dy], width, height) => ({x: x + dx - width / 2, y: y + dy - height / 2, width, height});
const overlaps = (a, b, margin) => a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
  && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
const within = (r, area) => !area || (r.x >= area.x && r.y >= area.y
  && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height);
const dotRect = d => ({x: d.x - d.radius, y: d.y - d.radius, width: 2 * d.radius, height: 2 * d.radius});

// labels: [{id, x, y, width, height, selected?, priority?}] with x/y the dot in screen pixels; a stop time
// label uses its stop as the dot. obstacles: fixed rectangles (map overlays). area: the visible map rectangle.
// Returns Map id → {placement, offset: [dx, dy], rect}.
export function placeLabels(labels, {obstacles = [], area = null} = {}) {
  const order = [...labels].sort((a, b) => Boolean(b.selected) - Boolean(a.selected) || (b.priority ?? 0) - (a.priority ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dots = order.map(l => ({id: l.id, x: l.x, y: l.y, radius: l.selected ? SELECTED_DOT_RADIUS : DOT_RADIUS}));
  const options = candidates(order.length);
  const placed = [];
  const result = new Map();
  for (const label of order) {
    const blocked = rect => placed.some(p => overlaps(rect, p, LABEL_MARGIN))
      || obstacles.some(o => overlaps(rect, o, LABEL_MARGIN))
      || dots.some(d => d.id !== label.id && overlaps(rect, dotRect(d), 0));
    const tried = options.map(placement => {
      const offset = labelOffset(placement, label.width, label.height);
      return {placement, offset, rect: rectAt(label.x, label.y, offset, label.width, label.height)};
    });
    const chosen = tried.find(c => !blocked(c.rect) && within(c.rect, area)) ?? tried.find(c => !blocked(c.rect)) ?? tried[0];
    placed.push(chosen.rect);
    result.set(label.id, chosen);
  }
  return result;
}
