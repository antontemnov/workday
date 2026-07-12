import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { WorkdayApiService } from './workday-api.service';
import { NotificationItem } from '../models/workday.models';

// Delivery half of the notification system (main window only). The daemon
// decides WHAT is pending; this service decides WHEN it reaches the screen:
// poll every minute, and only when the user is actually at the keyboard
// (OS input idle below the threshold) ack 'shown' and raise the toast window.
// The 'shown' ack lands BEFORE the toast — the daemon's persisted state is
// the at-most-once authority, a tray crash after the ack loses one delivery
// rather than ever double-nagging.
@Injectable({ providedIn: 'root' })
export class NotificationDeliveryService {
  private static readonly POLL_MS = 60_000;
  private static readonly IDLE_THRESHOLD_MS = 120_000;

  private timer: ReturnType<typeof setInterval> | null = null;
  private delivering = false;

  public constructor(private api: WorkdayApiService) {}

  public start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), NotificationDeliveryService.POLL_MS);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      // Older daemons 404 here — res.ok false, the tick silently skips.
      const res = await this.api.getNotifications();
      const pending = res.ok ? res.data?.notifications ?? [] : [];
      if (pending.length === 0) return;

      const idle = await this.getIdleMs();
      if (idle === null || idle >= NotificationDeliveryService.IDLE_THRESHOLD_MS) return;

      // One per tick; the rest re-surface on following ticks.
      const item: NotificationItem = pending[0];
      const ack = await this.api.ackNotification(item.id, 'shown');
      if (!ack.ok) return;
      await invoke('show_toast', { payload: item });
    } catch {
      // Outside Tauri (browser dev) or a transient invoke failure — next tick retries.
    } finally {
      this.delivering = false;
    }
  }

  /** OS input idle in ms; null outside the Tauri runtime (browser dev). */
  private async getIdleMs(): Promise<number | null> {
    try {
      return await invoke<number>('get_idle_ms');
    } catch {
      return null;
    }
  }
}
