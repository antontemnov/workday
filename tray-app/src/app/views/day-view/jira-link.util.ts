// "Open in browser" — shared between the ticket-block menu and the
// suggestion-row menu. Base URL comes from the status poll (jiraBaseUrl),
// absent on daemons < 0.41.0 → callers hide the item.

import { open as shellOpen } from '@tauri-apps/plugin-shell';

// Mirrors the daemon's JIRA_KEY_PATTERN — '—' (taskless) blocks have no page.
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

// Globe icon (inline SVG — crisp on fractional DPI).
export const GLOBE_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="6" cy="6" r="4.6"/><ellipse cx="6" cy="6" rx="2.1" ry="4.6"/><line x1="1.4" y1="6" x2="10.6" y2="6"/></svg>';

export function canBrowseTicket(jiraBaseUrl: string | null, task: string): boolean {
  return !!jiraBaseUrl && TICKET_KEY_RE.test(task);
}

export function openTicketInBrowser(jiraBaseUrl: string | null, task: string): void {
  if (!jiraBaseUrl) return;
  const url = `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${task}`;
  // Outside Tauri (browser dev) the plugin throws — a plain tab will do.
  void shellOpen(url).catch(() => window.open(url, '_blank'));
}
