import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionDetail, SensitivityLevel, SensitivityPill } from '../../../models/workday.models';
import { DurationFieldComponent } from '../duration-field/duration-field.component';
import { parseDurationToMinutes } from '../duration-field/duration.util';
import { openCtxMenu } from '../ctx-menu.util';

interface SpeedPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

type TrackingAction = 'pause' | 'resume';

/**
 * Single open-session card — one grid, two bands, the ticket medallion
 * spanning both (the card keeps the feed rows' uniform height):
 *   medallion — the tracking control (lamp: green = accruing, grey = not;
 *               hover morphs to Pause / Resume where an action exists)
 *   band 1 — Jira ticket name (branch until the summary is cached) · time
 *   band 2 — repo · commits · churn
 * Stamina stays the card's bottom edge; the tracked highlight is a glass
 * rim — a faint catch-light on the border tinted by the same state. Any
 * paused card drops its colour halo entirely: tracking is binary here.
 *
 * Mostly a projection of one SessionDetail; the only local state is the
 * anchored Add-time popover (open flag + duration text), like the mode
 * dropdown's own open state.
 */
@Component({
  selector: 'app-session-card',
  standalone: true,
  imports: [CommonModule, DurationFieldComponent],
  templateUrl: './session-card.component.html',
  styleUrl: './session-card.component.scss',
})
export class SessionCardComponent {
  @Input({ required: true }) session!: SessionDetail;
  @Input() actionPending = false;
  @Input() speedPills: readonly SpeedPillOption[] = [];
  // Jira summaries from the day payload (task key → name, cached by the daemon).
  @Input() issueSummaries: Readonly<Record<string, string>> = {};

  // Re-uses the existing pill channel: 'pause' → pause API, a level → sensitivity API.
  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeSubmitted = new EventEmitter<{ session: SessionDetail; minutes: number }>();

  // Add-time popover (anchored to the time chip). Default 30m; attemptedAdd
  // flags the duration red only after a failed submit.
  addPopoverOpen = false;
  addTimeStr = '30m';
  attemptedAdd = false;

  // ─── Identity ──────────────────────────────────────────────────────────

  get repoName(): string {
    return this.session.repo.split('/').pop() ?? this.session.repo;
  }

  // Ticket name for the name slot; the branch stands in (dimmed) until the
  // daemon backfills the summary.
  get ticketName(): string | null {
    return this.session.task ? this.issueSummaries[this.session.task] ?? null : null;
  }

  // ─── Tracking status — binary on purpose ───────────────────────────────
  // The chip's dot answers the only question that matters: is time accruing
  // right now? The why of a pause (idle / switched / away / manual) stays out
  // of the UI — the daemon knows, the user doesn't need to.

  get isAccruing(): boolean {
    return !this.session.paused && this.session.state === 'active';
  }

  // System-stopped (idle / superseded / away): the cold, frozen-glass chip.
  // A manual pause is warmer — the user holds it, ⏸ waits for their ▶.
  get isAutoPaused(): boolean {
    return this.session.paused && (this.session.pauseSource ?? '').toLowerCase() !== 'manual';
  }

  // ─── Tracking action (Pause / Resume) ──────────────────────────────────
  // Shown only where it does something: Live → Pause, manual-paused → Resume.
  // Auto-pauses (idle/superseded/away) and pending have no button — a manual
  // resume there is a no-op (the evaluator re-pauses on the next tick), so the
  // status badge stands alone.
  get trackingAction(): TrackingAction | null {
    const s = this.session;
    if (s.paused) {
      return (s.pauseSource ?? '').toLowerCase() === 'manual' ? 'resume' : null;
    }
    return s.state === 'active' ? 'pause' : null;
  }

  get trackingActionTitle(): string {
    return this.trackingAction === 'pause' ? 'Pause this session' : 'Resume this session';
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

  // A Nonstop session that has yielded (Switched) or been manually paused: the
  // stamina bar is meaningless here (no idle leash applies), so the edge shows an
  // empty track and no tooltip — the status badge already says Switched/Paused.
  get isNonstopPaused(): boolean {
    return this.session.paused && this.session.sensitivity === SensitivityLevel.AlwaysOn;
  }

  // ─── Stamina edge ──────────────────────────────────────────────────────

  get staminaPercent(): number {
    return Math.round(Math.max(0, Math.min(1, this.session.normalizedScore)) * 100);
  }

  get staminaColor(): string {
    // Binary halo: any card that isn't accruing shows a grey gauge — the
    // colour (and the rim's tint) belongs to running tracking only.
    if (!this.isAccruing) return '#45475a';
    const n = this.session.normalizedScore;
    if (n >= 0.6) return '#a6e3a1';
    if (n >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  get staminaTooltip(): string {
    if (this.isManualPaused) return `Frozen · ${this.staminaPercent}%`;
    if (this.isAlwaysOn) return 'Nonstop — no idle pause';
    return `Stamina ${this.staminaPercent}%`;
  }

  // Tracked highlight — the glass rim's catch-light follows the edge fill:
  // stamina colour while accruing, an electric sky-blue for Nonstop, plain
  // glass (neutral) the moment tracking stops. The quad is
  // [top catch-light, bottom counter-glint, strong sweep, soft post-wave] —
  // same hue family; the strong sweep speaks loudest, its echo whispers.
  private get glintPair(): readonly [string, string, string, string] {
    if (this.isAlwaysOn) {
      return [
        'rgba(116, 199, 236, 0.4)', 'rgba(137, 180, 250, 0.14)',
        'rgba(137, 180, 250, 0.8)', 'rgba(148, 226, 213, 0.32)',
      ];
    }
    const n = this.session.normalizedScore;
    if (!this.isAccruing || n <= 0) {
      return [
        'rgba(205, 214, 244, 0.14)', 'rgba(205, 214, 244, 0.05)',
        'rgba(205, 214, 244, 0.3)', 'rgba(205, 214, 244, 0.12)',
      ];
    }
    if (n >= 0.6) {
      return [
        'rgba(166, 227, 161, 0.4)', 'rgba(166, 227, 161, 0.13)',
        'rgba(166, 227, 161, 0.8)', 'rgba(166, 227, 161, 0.3)',
      ];
    }
    if (n >= 0.3) {
      return [
        'rgba(249, 226, 175, 0.36)', 'rgba(249, 226, 175, 0.12)',
        'rgba(249, 226, 175, 0.75)', 'rgba(249, 226, 175, 0.28)',
      ];
    }
    return [
      'rgba(243, 139, 168, 0.34)', 'rgba(243, 139, 168, 0.11)',
      'rgba(243, 139, 168, 0.75)', 'rgba(243, 139, 168, 0.28)',
    ];
  }

  get stateGlint(): string {
    return this.glintPair[0];
  }

  get stateGlintSoft(): string {
    return this.glintPair[1];
  }

  get stateSweep(): string {
    return this.glintPair[2];
  }

  get stateSweepSoft(): string {
    return this.glintPair[3];
  }

  // ─── Time ──────────────────────────────────────────────────────────────

  get effectiveLabel(): string {
    return this.formatDurationHm(this.session.effectiveDurationMs);
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
    if (this.isManualPaused || this.actionPending) return;
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

  // ─── Mode context menu (right-click) ───────────────────────────────────
  // Replaces the inline dropdown: the card's rare per-session action now lives
  // in the same two-stage popover the suggestion / logged rows use. Stage 1
  // carries only Mode; stage 2 is the sensitivity picker (Back + the levels).

  onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.actionPending || this.addPopoverOpen) return;
    this.openMainMenu(ev.clientX, ev.clientY);
  }

  private openMainMenu(x: number, y: number): void {
    // The active mode rides along as a dimmed right-aligned hint, so it reads
    // without opening the sub-menu. Manual pause freezes the scale, so Mode
    // states the fact (dimmed + "paused") rather than offering a no-op — the
    // same "disabled fact" language as the logged rows.
    const current = this.speedPills.find(o => o.key === this.session.sensitivity)?.label ?? '—';
    openCtxMenu(x, y, [
      this.isManualPaused
        ? { icon: '⊙', label: 'Mode', hint: `${current} · paused`, disabled: true,
            title: 'Resume the session to change its mode', action: (): void => {} }
        : { icon: '⊙', label: 'Mode', hint: current, action: (): void => this.openModeMenu(x, y) },
    ]);
  }

  private openModeMenu(x: number, y: number): void {
    openCtxMenu(x, y, [
      { label: '← Back', action: () => this.openMainMenu(x, y) },
      { separator: true },
      ...this.speedPills.map(o => ({
        // Reserve the icon gutter on every row (space when unselected) so the
        // ✓ on the active mode keeps the labels aligned.
        icon: o.key === this.session.sensitivity ? '✓' : ' ',
        label: o.label,
        title: o.title,
        action: (): void => this.onSpeedClick(o.key),
      })),
    ]);
  }

  // ─── Add-time popover ──────────────────────────────────────────────────
  // Tops up this session's tracked time. Mirrors the LOG TIME composer (shared
  // DurationFieldComponent: free-text "1h 30m", quick-picks, wheel).

  // A session without a task can't produce an entry; a pending session is
  // not in the daily log yet (activity-gated), so the daemon would answer
  // "Session not found" — the chip stays disabled until activation.
  get canAddTime(): boolean {
    return !!this.session.task && !!this.session.activatedAt;
  }

  get timeChipTitle(): string {
    if (this.canAddTime) return 'Click to add manual time';
    if (!this.session.task) return 'No task — use Log to add time';
    return 'Pending — add time becomes available once the session starts';
  }

  onTimeClick(): void {
    if (!this.canAddTime || this.actionPending) return;
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
