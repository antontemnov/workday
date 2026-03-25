import { Injectable } from '@angular/core';
import { ApiResponse, TodayResponse, StatusResponse } from '../models/workday.models';

/**
 * Abstract API service — implementations:
 * - HttpWorkdayApiService (direct HTTP to localhost daemon)
 * - Future: TelegramWorkdayApiService (via tunnel/proxy)
 */
@Injectable()
export abstract class WorkdayApiService {
  abstract getToday(): Promise<ApiResponse<TodayResponse>>;
  abstract getDay(date: string): Promise<ApiResponse<TodayResponse>>;
  abstract getStatus(): Promise<ApiResponse<StatusResponse>>;
  abstract pause(repo?: string): Promise<ApiResponse<{ paused: string[] }>>;
  abstract resume(): Promise<ApiResponse<{ resumed: string[] }>>;
  abstract adjust(target: string, minutes: number, reason: string): Promise<ApiResponse<unknown>>;
  abstract stop(): Promise<ApiResponse<unknown>>;
}
