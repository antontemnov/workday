import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionDetail, SensitivityLevel, SensitivityPill } from '../../../models/workday.models';
import { ModeDropdownComponent } from './mode-dropdown/mode-dropdown.component';
import { StatusBadgeComponent } from './status-badge/status-badge.component';
import { DurationFieldComponent } from '../duration-field/duration-field.component';
import { parseDurationToMinutes } from '../duration-field/duration.util';

interface SpeedPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

type TrackingAction = 'pause' | 'resume';

/**
 * Single open-session card. Compact 2-row layout:
 *   1. identity   — repo │ branch (fade-masked) · status badge (Pause/Resume
 *                   built into the badge for Live/manual-paused)
 *   2. metrics    — clickable time (+manual) · git stats · mode dropdown
 * Stamina is the card's bottom edge, not a row.
 *
 * Mostly a projection of one SessionDetail; the only local state is the
 * anchored Add-time popover (open flag + duration text), like the mode
 * dropdown's own open state.
 */
@Component({
  selector: 'app-session-card',
  standalone: true,
  imports: [CommonModule, ModeDropdownComponent, StatusBadgeComponent, DurationFieldComponent],
  templateUrl: './session-card.component.html',
  styleUrl: './session-card.component.scss',
})
export class SessionCardComponent {
  @Input({ required: true }) session!: SessionDetail;
  @Input() isViewingToday = true;
  @Input() actionPending = false;
  @Input() speedPills: readonly SpeedPillOption[] = [];

  // Re-uses the existing pill channel: 'pause' → pause API, a level → sensitivity API.
  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeSubmitted = new EventEmitter<{ session: SessionDetail; minutes: number }>();

  // True while the mode dropdown is open — lets the card lift its z-index so the
  // menu can overflow the card without a sibling card clipping it.
  menuOpen = false;

  // Add-time popover (anchored to the time chip). Default 30m; attemptedAdd
  // flags the duration red only after a failed submit.
  addPopoverOpen = false;
  addTimeStr = '30m';
  attemptedAdd = false;

  // ─── Identity ──────────────────────────────────────────────────────────

  get repoName(): string {
    return this.session.repo.split('/').pop() ?? this.session.repo;
  }

  // ─── Status badge ──────────────────────────────────────────────────────

  get statusClass(): string {
    const s = this.session;
    if (s.paused) {
      switch ((s.pauseSource ?? '').toLowerCase()) {
        case 'idle_timeout': return 'status-idle';
        case 'superseded':   return 'status-switched';
        case 'teams_away':   return 'status-away';
        default:             return 'status-paused';
      }
    }
    return s.state === 'active' ? 'status-live' : 'status-pending';
  }

  get statusLabel(): string {
    const s = this.session;
    if (s.paused) {
      switch ((s.pauseSource ?? '').toLowerCase()) {
        case 'idle_timeout': return 'Idle';
        case 'superseded':   return 'Switched';
        case 'teams_away':   return 'Away';
        default:             return 'Paused';
      }
    }
    return s.state === 'active' ? 'Live' : 'Pending';
  }

  // ─── Tracking action (Pause / Resume) ──────────────────────────────────
  // Shown only where it does something: Live → Pause, manual-paused → Resume.
  // Auto-pauses (idle/superseded/away) and pending have no button — a manual
  // resume there is a no-op (the evaluator re-pauses on the next tick), so the
  // status badge stands alone.
  get trackingAction(): TrackingAction | null {
    const s = this.session;
    if (!this.isViewingToday) return null;
    if (s.paused) {
      return (s.pauseSource ?? '').toLowerCase() === 'manual' ? 'resume' : null;
    }
    return s.state === 'active' ? 'pause' : null;
  }

  // ─── Sensitivity scale ─────────────────────────────────────────────────

  get isPaused(): boolean {
    return this.session.paused;
  }

  // Manual pause is the only "frozen" state — scale locks, stamina stops
  // draining. Auto-pauses (idle/superseded/away) keep the scale live so you can
  // still bump sensitivity (e.g. to Nonstop) to change what happens next.
  get isManualPaused(): boolean {
    return this.session.paused && (this.session.pauseSource ?? '').toLowerCase() === 'manual';
  }

  get isAlwaysOn(): boolean {
    return !this.session.paused && this.session.sensitivity === SensitivityLevel.AlwaysOn;
  }

  // ─── Stamina edge ──────────────────────────────────────────────────────

  get staminaPercent(): number {
    return Math.round(Math.max(0, Math.min(1, this.session.normalizedScore)) * 100);
  }

  get staminaColor(): string {
    if (this.isManualPaused) return '#45475a'; // frozen — drain is suspended
    const n = this.session.normalizedScore;
    if (n >= 0.6) return '#a6e3a1';
    if (n >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  get staminaTooltip(): string {
    if (this.isManualPaused) return `Frozen · ${this.staminaPercent}%`;
    if (this.isAlwaysOn) return 'Always tracking — no idle pause';
    return `Stamina ${this.staminaPercent}%`;
  }

  // ─── Time ──────────────────────────────────────────────────────────────

  get effectiveLabel(): string {
    return this.formatDurationHm(this.session.effectiveDurationMs);
  }

  get manualLabel(): string | null {
    return this.session.manualMinutes > 0
      ? `+${this.formatDurationHm(this.session.manualMinutes * 60_000)}`
      : null;
  }

  // Total time this session spent paused — duration only, no count. Shown in the
  // time chip when there was any pause (mirrors how +manual only shows when > 0).
  get pauseLabel(): string | null {
    return this.session.totalPauseDurationMs > 0
      ? this.formatDurationHm(this.session.totalPauseDurationMs)
      : null;
  }

  formatDurationHm(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  onSpeedClick(level: SensitivityLevel): void {
    if (this.isManualPaused || this.actionPending || !this.isViewingToday) return;
    if (level === this.session.sensitivity) return;
    this.pillSelected.emit({ session: this.session, pill: level });
  }

  onTrackingClick(): void {
    if (this.actionPending) return;
    const action = this.trackingAction;
    if (action === 'pause') {
      this.pillSelected.emit({ session: this.session, pill: 'pause' });
    } else if (action === 'resume') {
      // Resume = clear the manual pause by re-applying the current sensitivity;
      // the daemon closes the open manual pause as a side-effect of setSensitivity.
      this.pillSelected.emit({ session: this.session, pill: this.session.sensitivity });
    }
  }

  // ─── Add-time popover ──────────────────────────────────────────────────
  // Tops up this session's tracked time. Mirrors the LOG TIME composer (shared
  // DurationFieldComponent: free-text "1h 30m", quick-picks, wheel).

  onTimeClick(): void {
    if (!this.isViewingToday || this.actionPending) return;
    if (this.addPopoverOpen) { this.closeAddPopover(); return; }
    this.addTimeStr = '30m';
    this.attemptedAdd = false;
    this.addPopoverOpen = true;
  }

  closeAddPopover(): void {
    this.addPopoverOpen = false;
  }

  // Repo · task context shown under the popover title (task is the session's).
  get addSubtitle(): string {
    return this.session.task ? `${this.repoName} · ${this.session.task}` : this.repoName;
  }

  get parsedAddMinutes(): number | null {
    return parseDurationToMinutes(this.addTimeStr);
  }

  get addMinutesInvalid(): boolean {
    return this.parsedAddMinutes === null;
  }

  applyAdd(): void {
    if (this.actionPending) return;
    const minutes = this.parsedAddMinutes;
    if (minutes === null) { this.attemptedAdd = true; return; }
    this.addTimeSubmitted.emit({ session: this.session, minutes });
    this.closeAddPopover();
  }
}
