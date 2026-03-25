import { Injectable } from '@angular/core';
import { WorkdayApiService } from './workday-api.service';
import { ApiResponse, TodayResponse, StatusResponse } from '../models/workday.models';

const BASE_URL = 'http://127.0.0.1:9213';

@Injectable()
export class HttpWorkdayApiService extends WorkdayApiService {

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    try {
      const res = await fetch(`${BASE_URL}${path}`);
      return await res.json();
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
      return await res.json();
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
