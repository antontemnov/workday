// Resizable Logged columns: name and type are user-draggable px widths (desc
// is the elastic remainder). One storage key — the day view's Logged panel
// owns the drag, the timesheets drawers read the same layout so both tables
// look identical.

export interface LoggedCols {
  readonly name: number;
  readonly type: number;
}

export const LOGGED_COL_DEFAULT: LoggedCols = { name: 140, type: 92 };
export const LOGGED_COL_MIN = { name: 64, type: 56, desc: 44 } as const;

const COL_STORAGE_KEY = 'workday.logged.cols';

export function loadLoggedCols(): LoggedCols {
  try {
    const raw = localStorage.getItem(COL_STORAGE_KEY);
    if (!raw) return LOGGED_COL_DEFAULT;
    const v = JSON.parse(raw) as { name?: number; type?: number };
    return {
      name: typeof v.name === 'number' ? Math.max(LOGGED_COL_MIN.name, v.name) : LOGGED_COL_DEFAULT.name,
      type: typeof v.type === 'number' ? Math.max(LOGGED_COL_MIN.type, v.type) : LOGGED_COL_DEFAULT.type,
    };
  } catch {
    return LOGGED_COL_DEFAULT; // no persisted layout
  }
}

export function persistLoggedCols(cols: LoggedCols): void {
  try {
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(cols));
  } catch { /* storage unavailable — keep the in-memory widths */ }
}
