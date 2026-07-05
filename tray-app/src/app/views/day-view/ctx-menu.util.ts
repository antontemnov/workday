// Custom context menu (design iter.12) — one mechanic for every rare row/chip
// operation. Rendered on document.body (like the fly-chip clone) so panel
// transforms never offset the fixed positioning; styled by the global
// .ctx-menu rules in styles.scss. One menu at a time.

export interface CtxMenuItem {
  readonly icon: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly action: () => void;
}

let menuEl: HTMLElement | null = null;
let removeListeners: (() => void) | null = null;

export function closeCtxMenu(): void {
  if (removeListeners) { removeListeners(); removeListeners = null; }
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

export function openCtxMenu(x: number, y: number, items: readonly CtxMenuItem[]): void {
  closeCtxMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '');
    const ic = document.createElement('span');
    ic.className = 'ci-ic';
    ic.textContent = item.icon;
    el.append(ic, document.createTextNode(item.label));
    el.addEventListener('click', () => { closeCtxMenu(); item.action(); });
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
