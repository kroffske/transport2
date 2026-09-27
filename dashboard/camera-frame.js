// Camera frame of the selected vehicle (merged UX spec §L5): the padding that keeps the vehicle,
// its target and the next stop inside the part of the map no panel covers. Pure geometry: the
// caller measures the panels (DOMRect-like {left, top, right, bottom}, viewport pixels) and passes
// the map pane's rect; nothing here touches the DOM or the map.

export const FRAME_MARGIN = 60; // clear space at the frame's left and right, and the minimum at every side
export const FRAME_GAP = 40; // clear space under the attention bar and above the legend
export const FRAME_LABEL_H = 26; // a vehicle or stop label drawn above its point
export const TARGET_LABEL_W = 240; // the target's time label when it is not measured yet
export const MIN_FRAME = 160; // the smallest frame fitBounds is left with; extras give way first
export const FRAME_MAX_ZOOM = 15;

// {top, bottom, left, right} for map.fitBounds.
//   pane:      the map pane
//   attention: the attention bar over the map, or null when hidden
//   legend:    the legend over the map, or null
//   overlay:   a panel over the map's right edge (the card panel at 1100–1599 px), or null
//   targetEast: the target is the frame's east-most point, so its label may run out to the right
//   targetLabelWidth: the measured width of the target label (defaults to TARGET_LABEL_W)
// When the panels leave less than MIN_FRAME, the target label's room goes first, then the side
// margins; the panel over the map is never given up, since a point under it is not visible.
export function framePadding({pane, attention = null, legend = null, overlay = null, targetEast = false, targetLabelWidth = TARGET_LABEL_W}) {
  const width = pane.right - pane.left;
  const height = pane.bottom - pane.top;
  const covered = overlay ? Math.max(0, Math.min(pane.right, overlay.right) - Math.max(pane.left, overlay.left)) : 0;
  const top = Math.max(FRAME_MARGIN, attention ? attention.bottom - pane.top + FRAME_GAP + FRAME_LABEL_H : FRAME_MARGIN);
  const bottom = Math.max(FRAME_MARGIN, legend ? pane.bottom - legend.top + FRAME_GAP : FRAME_MARGIN);
  const label = targetEast ? Math.max(0, targetLabelWidth) : 0;
  return {...fitY(height, top, bottom), ...fitX(width, covered, label)};
}

// Vertical: both sides shrink in proportion when they leave less than MIN_FRAME.
function fitY(size, top, bottom) {
  const room = size - MIN_FRAME;
  if (top + bottom <= room) return {top, bottom};
  const scale = Math.max(0, room) / (top + bottom);
  return {top: Math.floor(top * scale), bottom: Math.floor(bottom * scale)};
}

// Horizontal: the label's room shrinks first, then the two margins; the covered strip stays.
function fitX(size, covered, label) {
  let left = FRAME_MARGIN;
  let right = FRAME_MARGIN + covered + label;
  const excess = left + right - (size - MIN_FRAME);
  if (excess <= 0) return {left, right};
  const fromLabel = Math.min(label, excess);
  right -= fromLabel;
  const rest = excess - fromLabel;
  if (rest > 0) {
    const margins = Math.min(rest, 2 * FRAME_MARGIN);
    left -= Math.ceil(margins / 2);
    right -= Math.floor(margins / 2);
  }
  return {left: Math.max(0, left), right: Math.max(0, right)};
}

// A vehicle this far from its route (§L6) is not framed: the frame holds its target and the nearest
// part of its route, and the vehicle is an arrow at the frame's edge with the distance.
export const FAR_OFF_ROUTE_M = 2000;

// Where the edge arrow to an off-screen point sits: the ray from the zone's centre to `point`
// meets the zone's border (zone {left, top, right, bottom} and point {x, y} in the same pixels).
// `box` {width, height} is the arrow label, kept whole inside the zone. `angle` is the ray's
// direction in degrees, 0 = east, clockwise (screen y grows down). Null while the point is inside.
export function edgeAnchor(zone, point, box = {width: 0, height: 0}) {
  if (point.x >= zone.left && point.x <= zone.right && point.y >= zone.top && point.y <= zone.bottom) return null;
  const cx = (zone.left + zone.right) / 2;
  const cy = (zone.top + zone.bottom) / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const halfW = Math.max(0, (zone.right - zone.left - box.width) / 2);
  const halfH = Math.max(0, (zone.bottom - zone.top - box.height) / 2);
  const scale = Math.min(dx ? halfW / Math.abs(dx) : Infinity, dy ? halfH / Math.abs(dy) : Infinity);
  return {x: cx + dx * scale, y: cy + dy * scale, angle: (Math.atan2(dy, dx) * 180) / Math.PI};
}
