import { Injectable } from '@angular/core';
import {
  ApiResponse,
  TodayResponse,
  StatusResponse,
  SensitivityResponse,
  SensitivityLevel,
  AdjustResponse,
  DaysResponse,
  MonthResponse,
  SettingsResponse,
  SettingsPatch,
  AddRepoResponse,
  UpdateCheckResponse,
  UpdateApplyResponse,
  ActivityTypesResponse,
  ManualEntryResponse,
  ManualEntryInput,
  ManualEntryPatch,
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
  abstract adjust(target: string, minutes: number, reason: string): Promise<ApiResponse<AdjustResponse>>;
  abstract stop(): Promise<ApiResponse<unknown>>;
  abstract startDaemon(): Promise<void>;

  // Manual entries — standalone time on a task (HTTP add/edit target the
  // currently-tracked day only; past days are read-only from the UI).
  abstract getActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>>;
  abstract addManualEntry(input: ManualEntryInput): Promise<ApiResponse<ManualEntryResponse>>;
  abstract updateManualEntry(target: string, patch: ManualEntryPatch): Promise<ApiResponse<ManualEntryResponse>>;

  // Timesheets view — per-month aggregated day summaries.
  abstract getMonth(year: number, month: number): Promise<ApiResponse<MonthResponse>>;
  // Mark a day as Confirmed (Draft → Confirmed). Pushed status is set by the
  // push pipeline, not the user.
  abstract confirmDay(date: string): Promise<ApiResponse<unknown>>;
  // Trigger the Tempo push for a date range; daemon side wraps runPush().
  abstract pushToTempo(from: string, to: string): Promise<ApiResponse<unknown>>;

  // Settings view — config + secrets metadata. Token values are write-only.
  abstract getSettings(): Promise<ApiResponse<SettingsResponse>>;
  abstract updateSettings(patch: SettingsPatch): Promise<ApiResponse<unknown>>;
  // Repo list edits — separate endpoints so the daemon can validate paths.
  abstract addRepo(path: string): Promise<ApiResponse<AddRepoResponse>>;
  abstract removeRepo(path: string): Promise<ApiResponse<AddRepoResponse>>;

  // Daemon updates — check npm registry / install + restart the daemon.
  abstract checkDaemonUpdate(): Promise<ApiResponse<UpdateCheckResponse>>;
  abstract applyDaemonUpdate(): Promise<ApiResponse<UpdateApplyResponse>>;
}
