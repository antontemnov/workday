import { Injectable } from '@angular/core';
import {
  ApiResponse,
  TodayResponse,
  StatusResponse,
  SensitivityResponse,
  SensitivityLevel,
  SessionDeleteResponse,
  TaskDeleteResponse,
  DaysResponse,
  MonthResponse,
  SettingsResponse,
  SettingsPatch,
  AddRepoResponse,
  BrowsersResponse,
  OpenUrlResponse,
  UpdateCheckResponse,
  UpdateApplyResponse,
  ActivityTypesResponse,
  ManualEntryResponse,
  ManualEntryDeleteResponse,
  ManualEntryInput,
  ManualEntryPatch,
  FavoritesResponse,
  FavoriteAddResponse,
  FavoriteRemoveResponse,
  FavoriteInput,
  JiraSearchResponse,
  JiraProjectsResponse,
  PushResponse,
  TempoScheduleResponse,
  TempoApprovalResponse,
  TempoSyncResponse,
  TempoImportRequest,
  TempoImportResponse,
  NotificationsResponse,
  NotificationAckAction,
  NotificationAckResponse,
  CalendarRefreshResponse,
  SuggestionsResponse,
  SuggestionAcceptRequest,
  SuggestionAcceptResponse,
  SuggestionsMutedResponse,
  SuggestionUnmuteResponse,
} from '../models/workday.models';

/**
 * Abstract API service — implementations:
 * - HttpWorkdayApiService (direct HTTP to localhost daemon)
 * - Future: TelegramWorkdayApiService (via tunnel/proxy)
 */
@Injectable()
export abstract class WorkdayApiService {
  abstract getToday(): Promise<ApiResponse<TodayResponse>>;
  abstract getDay(date: string): Promise<ApiResponse<TodayResponse>>;
  abstract getDays(): Promise<ApiResponse<DaysResponse>>;
  abstract getStatus(): Promise<ApiResponse<StatusResponse>>;
  abstract pause(repo?: string): Promise<ApiResponse<{ paused: string[] }>>;
  abstract resume(): Promise<ApiResponse<{ resumed: string[] }>>;
  abstract sensitivity(level: SensitivityLevel, repo?: string): Promise<ApiResponse<SensitivityResponse>>;
  // "+ Add time" on a session card → session-born manual entry: the daemon
  // takes the task from the session, activity is Development, no description.
  abstract addSessionTime(sessionId: string, minutes: number): Promise<ApiResponse<ManualEntryResponse>>;
  // Review-time cleanup: delete a closed session. Optional date (YYYY-MM-DD)
  // for past days (timesheets) — omitted = the currently-tracked day.
  abstract deleteSession(target: string, date?: string): Promise<ApiResponse<SessionDeleteResponse>>;
  // Delete a ticket's whole tracked block: closed sessions + session-born
  // "+ Add time" entries. Standalone manual entries stay.
  abstract deleteTask(task: string, date?: string): Promise<ApiResponse<TaskDeleteResponse>>;
  abstract stop(): Promise<ApiResponse<unknown>>;
  abstract startDaemon(): Promise<void>;

  // Supervisor surface (tray-local Tauri commands, not daemon HTTP):
  // manual-stop marker written by the daemon — the watchdog never respawns
  // a deliberately stopped daemon; autostart = launch-at-login toggle.
  abstract isDaemonManuallyStopped(): Promise<boolean>;
  abstract getAutostartEnabled(): Promise<boolean>;
  abstract setAutostartEnabled(enabled: boolean): Promise<void>;

  // Manual entries — standalone time on a task. add targets the currently-
  // tracked day; update/delete take an optional date (YYYY-MM-DD) for past
  // days (timesheets drawer) — omitted = the currently-tracked day.
  abstract getActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>>;
  // Force-refetch the _Activity_ catalog from Tempo (Settings) — the Jira
  // projects refresh's twin.
  abstract refreshActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>>;
  abstract addManualEntry(input: ManualEntryInput): Promise<ApiResponse<ManualEntryResponse>>;
  abstract updateManualEntry(target: string, patch: ManualEntryPatch, date?: string): Promise<ApiResponse<ManualEntryResponse>>;
  // Session-born entries are deletable too (unlike edit). target = #index or id.
  abstract deleteManualEntry(target: string, date?: string): Promise<ApiResponse<ManualEntryDeleteResponse>>;

  // Favorites — reusable log templates for the log cloud (day-independent,
  // stored in the daemon's favorites.json). target = favorite id.
  abstract getFavorites(): Promise<ApiResponse<FavoritesResponse>>;
  abstract addFavorite(input: FavoriteInput): Promise<ApiResponse<FavoriteAddResponse>>;
  abstract removeFavorite(target: string): Promise<ApiResponse<FavoriteRemoveResponse>>;

  // Live Jira issue search (log-cloud fallback when favorites don't match).
  // errorCode 'jira-not-configured' → the UI blocks the search section with
  // a Settings link; debounce/min-length live on the UI side.
  abstract searchJira(query: string): Promise<ApiResponse<JiraSearchResponse>>;

  // Search-scope projects (Settings): cached catalog + selection, and a live
  // refresh that re-fetches the catalog from Jira and persists it.
  abstract getJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>>;
  abstract refreshJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>>;

  // Timesheets view — per-month aggregated day summaries (disk truth, offline).
  abstract getMonth(year: number, month: number): Promise<ApiResponse<MonthResponse>>;
  // Trigger the Tempo push for a date range; daemon side wraps runPush().
  // force overwrites Tempo-side edits after the user confirmed the conflicts.
  abstract pushToTempo(from: string, to: string, force?: boolean): Promise<ApiResponse<PushResponse>>;
  // Tempo-side month meta — cached daemon-side, {available:false} degrades
  // the UI silently (missing token scope / network failure).
  abstract getTempoSchedule(year: number, month: number): Promise<ApiResponse<TempoScheduleResponse>>;
  abstract getTempoApproval(year: number, month: number): Promise<ApiResponse<TempoApprovalResponse>>;
  // Refetch the month's Tempo snapshot so day statuses reflect the actual
  // remote state. Read-only pull — never required for (and never blocks) push.
  abstract syncTempo(year: number, month: number): Promise<ApiResponse<TempoSyncResponse>>;
  // Adopt foreign (Tempo-only) worklogs as local manual entries with
  // ownership — they become editable/deletable mirror citizens.
  abstract importTempo(request: TempoImportRequest): Promise<ApiResponse<TempoImportResponse>>;

  // Desktop notifications — the daemon owns rules + state, the tray delivers.
  // getNotifications returns pending items; ack 'shown' BEFORE toasting
  // (at-most-once), 'opened'/'hidden' after the user acts.
  abstract getNotifications(): Promise<ApiResponse<NotificationsResponse>>;
  abstract ackNotification(id: string, action: NotificationAckAction): Promise<ApiResponse<NotificationAckResponse>>;

  // Outlook ICS feed (meeting suggestions groundwork) — re-fetch now; feed
  // status rides on getStatus().calendar.
  abstract refreshCalendar(): Promise<ApiResponse<CalendarRefreshResponse>>;

  // Meeting suggestions — derived daemon-side on every read. Accept creates
  // a standalone ManualEntry carrying sourceRef; dismiss is permanent per
  // uid+date. Both return the recomputed day. Rows carry the learned ticket
  // resolution (resolved prefill / candidates on a titleKey conflict).
  abstract getSuggestions(date?: string): Promise<ApiResponse<SuggestionsResponse>>;
  abstract acceptSuggestion(request: SuggestionAcceptRequest): Promise<ApiResponse<SuggestionAcceptResponse>>;
  abstract dismissSuggestion(uid: string, date: string): Promise<ApiResponse<SuggestionsResponse>>;
  // Manual series mute (suggestion context menu) — days absent → forever.
  // Muted series feed the Settings→Calendar panel; unmute releases them.
  abstract muteSuggestion(uid: string, date: string, days?: number): Promise<ApiResponse<SuggestionsResponse>>;
  abstract getMutedSuggestions(): Promise<ApiResponse<SuggestionsMutedResponse>>;
  abstract unmuteSuggestion(uid: string): Promise<ApiResponse<SuggestionUnmuteResponse>>;
  abstract unmuteAllSuggestions(): Promise<ApiResponse<SuggestionUnmuteResponse>>;

  // Settings view — config + secrets metadata. Token values are write-only.
  abstract getSettings(): Promise<ApiResponse<SettingsResponse>>;
  abstract updateSettings(patch: SettingsPatch): Promise<ApiResponse<unknown>>;
  // Repo list edits — separate endpoints so the daemon can validate paths.
  abstract addRepo(path: string): Promise<ApiResponse<AddRepoResponse>>;
  abstract removeRepo(path: string): Promise<ApiResponse<AddRepoResponse>>;

  // Link opening — installed-browser inventory (Settings dropdown) and the
  // open itself, routed through the daemon so config.browser applies.
  abstract getBrowsers(): Promise<ApiResponse<BrowsersResponse>>;
  abstract openUrl(url: string): Promise<ApiResponse<OpenUrlResponse>>;

  // Daemon updates — check npm registry / install + restart the daemon.
  abstract checkDaemonUpdate(): Promise<ApiResponse<UpdateCheckResponse>>;
  abstract applyDaemonUpdate(): Promise<ApiResponse<UpdateApplyResponse>>;

  // Tray-app self-update (Tauri updater, not daemon HTTP). getAppVersion reads
  // the bundled version; checkAppUpdate returns the found version (null = up to
  // date) and raises the install banner as a side effect. Install is banner-only.
  abstract getAppVersion(): Promise<string>;
  abstract checkAppUpdate(): Promise<string | null>;
}
