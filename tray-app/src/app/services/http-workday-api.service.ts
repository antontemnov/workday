import { Injectable } from '@angular/core';
import { WorkdayApiService } from './workday-api.service';
import { ApiResponse, TodayResponse, StatusResponse, EXPECTED_API_VERSION } from '../models/workday.models';

const BASE_URL = 'http://127.0.0.1:9213';

@Injectable()
export class HttpWorkdayApiService extends WorkdayApiService {

  private checkApiVersion(response: ApiResponse<unknown>): ApiResponse<unknown> {
    if (response.ok && response.apiVersion !== undefined && response.apiVersion !== EXPECTED_API_VERSION) {
      return { ok: false, error: `API version mismatch: daemon v${response.apiVersion}, app expects v${EXPECTED_API_VERSION}. Update workday-daemon: npm i -g workday-daemon` };
    }
    return response;
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
