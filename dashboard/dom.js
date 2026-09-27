// Stable DOM across polls. Panels are rebuilt as fresh detached nodes on every snapshot and then
// merged into the live DOM here, so an element the user is pressing, hovering, typing into or
// scrolling survives the 1.5 s poll: a real click (mousedown and mouseup on the same node) is never
// lost to a re-render, and focus and scroll positions stay.
//
// Rules: a live node is kept and patched when the fresh node has the same type, tag and `data-key`;
// otherwise it is replaced. Children with a `data-key` are matched by key (moved, not recreated).
// A kept node keeps its own event listeners, so listeners must read current state at event time
// (look entities up by ID) instead of capturing objects; a node whose listeners depend on an entity
// carries that entity's ID in `data-key`.

const keyOf = node => (node.nodeType === 1 ? node.getAttribute('data-key') : null);
const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

function patchNode(live, fresh) {
  if (live.nodeType === 3 || live.nodeType === 8) {
    if (live.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue;
    return;
  }
  for (const {name} of [...live.attributes]) if (!fresh.hasAttribute(name)) live.removeAttribute(name);
  for (const {name, value} of [...fresh.attributes]) if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  // Properties that attributes do not carry once the user touched the control.
  if (live.nodeName === 'INPUT' || live.nodeName === 'TEXTAREA') {
    if (live.type === 'checkbox') live.checked = fresh.checked;
    else if (live !== document.activeElement && live.value !== fresh.value) live.value = fresh.value;
  }
  patchChildren(live, [...fresh.childNodes]);
}

// Make `container`'s children equal to `children` (fresh nodes), keeping matching live nodes.
export function patchChildren(container, children) {
  const keyed = new Map();
  for (const node of container.childNodes) if (keyOf(node) !== null) keyed.set(keyOf(node), node);
  let index = 0;
  for (const fresh of children) {
    const current = container.childNodes[index] ?? null;
    const key = keyOf(fresh);
    let live = current && same(current, fresh) ? current : key !== null ? keyed.get(key) ?? null : null;
    if (live && !same(live, fresh)) live = null;
    if (live) {
      if (live !== current) container.insertBefore(live, current);
      patchNode(live, fresh);
    } else {
      container.insertBefore(fresh, current);
    }
    index += 1;
  }
  while (container.childNodes.length > index) container.lastChild.remove();
}

// Replace the content of `container` with plain text, keeping the node when it already is that text.
export function patchText(container, content) {
  patchChildren(container, [document.createTextNode(content)]);
}
