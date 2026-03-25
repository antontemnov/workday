import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from './services/workday-api.service';
import { TodayResponse, SessionDetail } from './models/workday.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  data: TodayResponse | null = null;
  error: string | null = null;
  loading = true;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 10_000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async refresh(): Promise<void> {
    const res = await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
      this.error = null;
    } else {
      this.error = res.error ?? 'Unknown error';
    }
    this.loading = false;
  }

  get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  get closedSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => s.closedBy) ?? [];
  }

  get budgetPercent(): number {
    if (!this.data || !this.data.budgetMs) return 0;
    return Math.min(100, (this.data.claimedMs / this.data.budgetMs) * 100);
  }

  formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  repoName(repoPath: string): string {
    return repoPath.split('/').pop() ?? repoPath;
  }

  intensityColor(normalizedScore: number): string {
    if (normalizedScore >= 0.6) return '#a6e3a1';
    if (normalizedScore >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  intensityPercent(normalizedScore: number): number {
    return Math.round(Math.max(0, Math.min(1, normalizedScore)) * 100);
  }

  statusClass(session: SessionDetail): string {
    if (session.paused) return 'paused';
    if (session.state === 'active') return 'active';
    return 'pending';
  }

  statusLabel(session: SessionDetail): string {
    if (session.paused) return `PAUSED:${session.pauseSource}`;
    return session.state.toUpperCase();
  }
}
