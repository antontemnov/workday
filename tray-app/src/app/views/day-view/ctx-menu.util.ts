// Custom context menu (design iter.12) — one mechanic for every rare row/chip
// operation. Rendered on document.body (like the fly-chip clone) so panel
// transforms never offset the fixed positioning; styled by the global
// .ctx-menu rules in styles.scss. One menu at a time.

export interface CtxMenuItem {
  // Omitted/empty → the label starts at the menu edge (no icon gutter).
  readonly icon?: string;
  readonly label: string;
  readonly danger?: boolean;
  // Rendered dimmed and inert — states a fact ("In favorites") rather than
  // hiding the entry, so the mechanic stays discoverable.
  readonly disabled?: boolean;
  readonly title?: string;
  readonly action: () => void;
}

// Thin rule between groups (e.g. under a "← Back" row in a sub-menu).
export interface CtxMenuSeparator {
  readonly separator: true;
}

export type CtxMenuEntry = CtxMenuItem | CtxMenuSeparator;

let menuEl: HTMLElement | null = null;
let removeListeners: (() => void) | null = null;

export function closeCtxMenu(): void {
  if (removeListeners) { removeListeners(); removeListeners = null; }
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

export function openCtxMenu(x: number, y: number, items: readonly CtxMenuEntry[]): void {
  closeCtxMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    if (item.title) el.title = item.title;
    if (item.icon) {
      const ic = document.createElement('span');
      ic.className = 'ci-ic';
      ic.textContent = item.icon;
      el.appendChild(ic);
    }
    el.appendChild(document.createTextNode(item.label));
    if (!item.disabled) {
      el.addEventListener('click', () => { closeCtxMenu(); item.action(); });
    }
    menu.appendChild(el);
  }
  document.body.appendChild(menu);

  // Keep the popover on-screen: flip left / above the cursor near the edges.
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - 8 - rect.width;
  if (y + rect.height > window.innerHeight - 8) y = y - rect.height;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onPointerDown = (ev: Event): void => {
    if (menuEl && !menuEl.contains(ev.target as Node)) closeCtxMenu();
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
}
