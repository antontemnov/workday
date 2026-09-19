// Custom context menu (design iter.12) — one mechanic for every rare row/chip
// operation. Rendered on document.body (like the fly-chip clone) so panel
// transforms never offset the fixed positioning; styled by the global
// .ctx-menu rules in styles.scss. One menu at a time.
//
// Two ways in: openCtxMenu — at the cursor (right-click surfaces), and
// toggleAnchoredMenu — a left click on a row's anchor, the menu grows from
// under it and the anchor stays `.armed` while the menu lives.

export interface CtxMenuItem {
  // Omitted/empty → the label starts at the menu edge (no icon gutter).
  // A string starting with '<svg' renders as inline markup (crisp on
  // fractional DPI; stroke="currentColor" follows the item states) — anything
  // else is a text glyph.
  readonly icon?: string;
  readonly label: string;
  // Right-aligned, dimmed secondary text — the row's current value shown
  // inline (native-menu idiom), e.g. the active mode next to a "Mode" row, so
  // it reads without opening the sub-menu.
  readonly hint?: string;
  readonly danger?: boolean;
  // Rendered dimmed and inert — states a fact ("In favorites") rather than
  // hiding the entry, so the mechanic stays discoverable.
  readonly disabled?: boolean;
  readonly title?: string;
  // The row swaps the menu for another one in place: 'go' opens a sub-menu
  // (chevron), 'back' returns from it. The menu is not closed first — the
  // action's own open call replaces it without a second entrance.
  readonly nav?: 'go' | 'back';
  readonly action: () => void;
}

// Thin rule between groups (e.g. under a "← Back" row in a sub-menu).
export interface CtxMenuSeparator {
  readonly separator: true;
}

// The session's branch, whole — the row is the copy button: click copies,
// the glyph turns ✓, the menu closes a beat later.
export interface CtxMenuBranch {
  readonly branch: string;
  readonly copyIcon: string;
  readonly copiedIcon: string;
}

export type CtxMenuEntry = CtxMenuItem | CtxMenuSeparator | CtxMenuBranch;

const ANCHOR_DX = -10;
const ANCHOR_GAP = 6;
const EDGE_MARGIN = 8;
const COPIED_CLOSE_MS = 700;
// Two lines of the menu's max width; a longer branch folds its middle.
const BRANCH_MAX_CHARS = 84;
const BRANCH_HEAD_CHARS = 34;
const BRANCH_TAIL_CHARS = 49;

let menuEl: HTMLElement | null = null;
let menuAnchor: HTMLElement | null = null;
let removeListeners: (() => void) | null = null;

export function closeCtxMenu(): void {
  if (removeListeners) { removeListeners(); removeListeners = null; }
  if (menuEl) { menuEl.remove(); menuEl = null; }
  if (menuAnchor) { menuAnchor.classList.remove('armed'); menuAnchor = null; }
}

export function openCtxMenu(x: number, y: number, items: readonly CtxMenuEntry[]): void {
  closeCtxMenu();
  if (items.length === 0) return;
  const menu = buildMenu(items);
  document.body.appendChild(menu);

  // Keep the popover on-screen: flip left / above the cursor near the edges.
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - EDGE_MARGIN) x = window.innerWidth - EDGE_MARGIN - rect.width;
  if (y + rect.height > window.innerHeight - EDGE_MARGIN) y = y - rect.height;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  mount(menu, null);
}

// A second click on the same anchor closes its menu.
export function toggleAnchoredMenu(anchor: HTMLElement, build: () => readonly CtxMenuEntry[]): void {
  if (menuAnchor === anchor) closeCtxMenu();
  else openAnchoredMenu(anchor, build());
}

export function openAnchoredMenu(anchor: HTMLElement, items: readonly CtxMenuEntry[]): void {
  const sameAnchor = menuAnchor === anchor;
  closeCtxMenu();
  if (items.length === 0) return;
  const menu = buildMenu(items);
  menu.classList.add('anchored');
  // A sub-menu replaces its parent in place — no second entrance.
  if (sameAnchor) menu.style.animation = 'none';
  document.body.appendChild(menu);

  // Grows from under the anchor; pinned inside the right edge, flipped above
  // the anchor at the bottom one.
  const a = anchor.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  let x = a.left + ANCHOR_DX;
  let y = a.bottom + ANCHOR_GAP;
  if (x + rect.width > window.innerWidth - EDGE_MARGIN) x = window.innerWidth - EDGE_MARGIN - rect.width;
  if (y + rect.height > window.innerHeight - EDGE_MARGIN) y = a.top - ANCHOR_GAP - rect.height;
  menu.style.left = `${Math.max(EDGE_MARGIN, x)}px`;
  menu.style.top = `${Math.max(EDGE_MARGIN, y)}px`;

  mount(menu, anchor);
}

function buildMenu(items: readonly CtxMenuEntry[]): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    if ('branch' in item) {
      menu.appendChild(buildBranchRow(item));
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    if (item.title) el.title = item.title;
    if (item.icon) el.appendChild(iconEl(item.icon));
    el.appendChild(document.createTextNode(item.label));
    if (item.hint) {
      const hn = document.createElement('span');
      hn.className = 'ci-hint';
      hn.textContent = item.hint;
      el.appendChild(hn);
    }
    if (item.nav === 'go') {
      const go = document.createElement('span');
      go.className = 'ci-go' + (item.hint ? '' : ' lone');
      go.textContent = '›';
      el.appendChild(go);
    }
    if (!item.disabled) {
      el.addEventListener('click', () => {
        if (!item.nav) closeCtxMenu();
        item.action();
      });
    }
    menu.appendChild(el);
  }
  return menu;
}

function iconEl(icon: string): HTMLElement {
  const ic = document.createElement('span');
  ic.className = 'ci-ic';
  if (icon.startsWith('<svg')) ic.innerHTML = icon;
  else ic.textContent = icon;
  return ic;
}

function buildBranchRow(item: CtxMenuBranch): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ctx-branch';
  const ic = iconEl(item.copyIcon);
  const name = document.createElement('span');
  name.className = 'cb-name';
  // One colour, whole name; wraps only after - _ / (soft breaks).
  const fit = item.branch.length > BRANCH_MAX_CHARS
    ? `${item.branch.slice(0, BRANCH_HEAD_CHARS)}…${item.branch.slice(-BRANCH_TAIL_CHARS)}`
    : item.branch;
  for (const part of fit.split(/(?<=[-_/])/)) {
    name.appendChild(document.createTextNode(part));
    name.appendChild(document.createElement('wbr'));
  }
  row.append(ic, name);
  row.addEventListener('click', () => {
    copyText(item.branch);
    row.classList.add('copied');
    ic.innerHTML = item.copiedIcon;
    const own = menuEl;
    setTimeout(() => { if (menuEl === own) closeCtxMenu(); }, COPIED_CLOSE_MS);
  });
  return row;
}

function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyTextFallback(text));
  } else {
    copyTextFallback(text);
  }
}

// execCommand path for webviews without the async clipboard.
function copyTextFallback(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function mount(menu: HTMLElement, anchor: HTMLElement | null): void {
  const onPointerDown = (ev: Event): void => {
    const target = ev.target as Node;
    // The anchor's own click toggles — a mousedown on it must not pre-close.
    if (menuEl && !menuEl.contains(target) && !anchor?.contains(target)) closeCtxMenu();
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      // Swallow the Esc that closes the menu — the cloud's own Esc layers
      // (filter / batch / close) must not unwind on the same keypress.
      ev.stopPropagation();
      closeCtxMenu();
    }
  };
  const onWindowBlur = (): void => closeCtxMenu();

  // Capture phase: a mousedown anywhere (even inside handlers that stop
  // propagation) still dismisses the menu, like a native one.
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('wheel', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onWindowBlur);
  removeListeners = () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('wheel', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onWindowBlur);
  };

  menuEl = menu;
  if (anchor) {
    menuAnchor = anchor;
    anchor.classList.add('armed');
  }
}
