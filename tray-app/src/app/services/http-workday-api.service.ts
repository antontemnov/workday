import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { WorkdayApiService } from './workday-api.service';
import {
  ApiResponse,
  TodayResponse,
  StatusResponse,
  AutoPauseResponse,
  AdjustResponse,
  SetStartResponse,
  EXPECTED_API_VERSION,
} from '../models/workday.models';

const BASE_URL = 'http://127.0.0.1:9213';

@Injectable()
export class HttpWorkdayApiService extends WorkdayApiService {

  private upgrading = false;

  private upgradeError: string | null = null;

  private checkApiVersion(response: ApiResponse<unknown>): ApiResponse<unknown> {
    if (response.ok && response.apiVersion !== undefined && response.apiVersion !== EXPECTED_API_VERSION) {
      if (!this.upgrading) {
        this.upgradeDaemon();
      }
      const msg = this.upgradeError
        ? `Daemon upgrade failed: ${this.upgradeError}`
        : 'Updating daemon to match app version...';
      return { ok: false, error: msg };
    }
    return response;
  }

  private async upgradeDaemon(): Promise<void> {
    this.upgrading = true;
    this.upgradeError = null;
    try {
      await invoke('upgrade_daemon');
    } catch (e: unknown) {
      this.upgradeError = String(e);
    } finally {
      this.upgrading = false;
    }
  }

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    try {
      const res = await fetch(`${BASE_URL}${path}`);
      const json = await res.json();
      return this.checkApiVersion(json) as ApiResponse<T>;
    } catch {
      return { ok: false, error: 'Connection refused — is the daemon running?' };
    }
  }

  private async post<T>(path: string, body?: Record<string, unknown>): Promise<ApiResponse<T>> {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      return this.checkApiVersion(json) as ApiResponse<T>;
    } catch {
      return { ok: false, error: 'Connection refused — is the daemon running?' };
    }
  }

  override async getToday(): Promise<ApiResponse<TodayResponse>> {
    return this.get('/api/today');
  }

  override async getDay(date: string): Promise<ApiResponse<TodayResponse>> {
    return this.get(`/api/day?date=${date}`);
  }

  override async getStatus(): Promise<ApiResponse<StatusResponse>> {
    return this.get('/api/status');
  }

  override async pause(repo?: string): Promise<ApiResponse<{ paused: string[] }>> {
    return this.post('/api/pause', repo ? { repo } : {});
  }

  override async resume(): Promise<ApiResponse<{ resumed: string[] }>> {
    return this.post('/api/resume');
  }

  override async autopause(enabled: boolean, repo?: string): Promise<ApiResponse<AutoPauseResponse>> {
    return this.post('/api/autopause', repo ? { enabled, repo } : { enabled });
  }

  override async adjust(target: string, minutes: number, reason: string): Promise<ApiResponse<AdjustResponse>> {
    return this.post('/api/adjust', { target, minutes, reason });
  }

  override async setStart(time: string): Promise<ApiResponse<SetStartResponse>> {
    return this.post('/api/set-start', { time });
  }

  override async stop(): Promise<ApiResponse<unknown>> {
    return this.post('/api/stop');
  }

  override async startDaemon(): Promise<void> {
    try {
      await invoke('start_daemon');
    } catch {
      // Outside Tauri webview (e.g. browser dev mode) — invoke is unavailable
      throw new Error('Cannot start daemon outside Tauri app');
    }
  }
}
