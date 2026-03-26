import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { WorkdayApiService } from './workday-api.service';
import { ApiResponse, TodayResponse, StatusResponse, EXPECTED_API_VERSION } from '../models/workday.models';

const BASE_URL = 'http://127.0.0.1:9213';

@Injectable()
export class HttpWorkdayApiService extends WorkdayApiService {

  private upgrading = false;

  private checkApiVersion(response: ApiResponse<unknown>): ApiResponse<unknown> {
    if (response.ok && response.apiVersion !== undefined && response.apiVersion !== EXPECTED_API_VERSION) {
      if (!this.upgrading) {
        this.upgradeDaemon();
      }
      return { ok: false, error: 'Updating daemon to match app version...' };
    }
    return response;
  }

  private async upgradeDaemon(): Promise<void> {
    this.upgrading = true;
    try {
      await invoke('upgrade_daemon');
    } catch (e) {
      console.error('Daemon upgrade failed:', e);
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

  override async adjust(target: string, minutes: number, reason: string): Promise<ApiResponse<unknown>> {
    return this.post('/api/adjust', { target, minutes, reason });
  }

  override async stop(): Promise<ApiResponse<unknown>> {
    return this.post('/api/stop');
  }
}
