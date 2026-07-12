import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { WorkdayApiService } from '../services/workday-api.service';
import { NotificationItem } from '../models/workday.models';

// Root of the toast window (design: compact card, whole card clickable).
// Payload arrives via the pull handshake: get_pending_toast on boot →
// render hidden → toast_ready reveals the positioned window → fade in.
// The 'toast-payload' listener covers the reuse path (new notification
// while the window is already alive).
@Component({
  // Same selector as the main shell — index.html hosts <app-root>, and
  // main.ts picks which root component to bootstrap by window label.
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './toast-host.component.html',
  styleUrl: './toast-host.component.scss',
})
export class ToastHostComponent implements OnInit, OnDestroy {
  item: NotificationItem | null = null;
  revealed = false;
  private unlistenPayload: UnlistenFn | null = null;

  /** Tooltip for the whole-card click target. */
  get openTitle(): string {
    const action = this.item?.actions[0];
    return action ? action.label : 'Open';
  }

  constructor(private api: WorkdayApiService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.unlistenPayload = await listen<NotificationItem>('toast-payload', e => {
        // Reuse path — the window is already visible, no reveal dance.
        this.item = e.payload;
        this.revealed = true;
      });
      const pending = await invoke<NotificationItem | null>('get_pending_toast');
      if (pending) {
        this.item = pending;
        // Let Angular paint the card before the hidden window is shown.
        setTimeout(() => void this.reveal(), 50);
      }
    } catch {
      // Outside the Tauri runtime — nothing to render.
    }
  }

  ngOnDestroy(): void {
    if (this.unlistenPayload) this.unlistenPayload();
  }

  /** Position + show the window (Rust), then run the opacity fade. */
  private async reveal(): Promise<void> {
    try {
      await invoke('toast_ready');
    } catch {
      return; // window already closed
    }
    // Next tick so the transition plays on screen, not before the show.
    setTimeout(() => { this.revealed = true; }, 30);
  }

  /** Whole-card click: open the target view in the main window. */
  async onOpen(): Promise<void> {
    if (!this.item) return;
    const view = this.item.actions[0]?.view ?? 'sheet';
    void this.api.ackNotification(this.item.id, 'opened');
    try { await invoke('open_main_at_view', { view }); } catch { /* main window gone */ }
    // Last — closes this window.
    try { await invoke('hide_toast'); } catch { /* already closed */ }
  }

  async onHide(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.item) void this.api.ackNotification(this.item.id, 'hidden');
    try { await invoke('hide_toast'); } catch { /* already closed */ }
  }
}
