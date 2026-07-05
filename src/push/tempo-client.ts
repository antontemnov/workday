import { TEMPO_BASE_URL, TEMPO_RATE_LIMIT_MS, ACTIVITY_ATTRIBUTE_KEY, DEFAULT_ACTIVITY } from '../core/constants.js';
import type { TempoWorklog } from '../core/types.js';

interface CreateWorklogParams {
  readonly issueId: number;
  readonly authorAccountId: string;
  readonly timeSpentSeconds: number;
  readonly startDate: string;
  readonly description?: string;        // plain-text worklog description (manual entries)
  readonly activity?: string;           // _Activity_ value; defaults to DEFAULT_ACTIVITY
}

export interface TempoWorkAttribute {
  readonly key: string;
  readonly name: string;
  readonly type: string;                              // e.g. STATIC_LIST, ACCOUNT
  readonly values?: readonly string[];               // present for STATIC_LIST
  readonly names?: Readonly<Record<string, string>>; // value → display label
}

/** Tempo HTTP failure with the status preserved — 403 means "scope missing". */
export class TempoApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Raw /4/user-schedule day (DaySchedule in the Tempo OpenAPI spec). */
export interface TempoScheduleDay {
  readonly date: string;
  readonly requiredSeconds: number;
  readonly type: string;
  readonly holiday?: {
    readonly name?: string;
    readonly description?: string;
    readonly durationSeconds?: number;
  };
}

/** Raw /4/timesheet-approvals/user response (TimesheetApproval in the spec). */
export interface TempoTimesheetApproval {
  readonly period: { readonly from: string; readonly to: string };
  readonly requiredSeconds: number;
  readonly timeSpentSeconds: number;
  readonly status?: { readonly key?: string };
  readonly actions?: { readonly submit?: unknown };
}

export class TempoClient {
  private readonly token: string;
  private lastRequestTime: number = 0;

  public constructor(token: string) {
    this.token = token;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < TEMPO_RATE_LIMIT_MS) {
      await new Promise<void>(r => setTimeout(r, TEMPO_RATE_LIMIT_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.rateLimit();
    const url = `${TEMPO_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new TempoApiError(res.status, `Tempo API ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
    }

    // DELETE returns 204 No Content
    if (res.status === 204) return {};
    return res.json();
  }

  /** Fetch user worklogs for a date range with pagination */
  public async getUserWorklogs(accountId: string, from: string, to: string): Promise<TempoWorklog[]> {
    const allWorklogs: TempoWorklog[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const path = `/4/worklogs/user/${encodeURIComponent(accountId)}`
        + `?from=${from}&to=${to}&offset=${offset}&limit=${limit}`;
      const response = await this.request('GET', path) as {
        results?: Array<{
          tempoWorklogId: number;
          issue?: { id: number };
          issueId?: number;
          startDate: string;
          timeSpentSeconds: number;
        }>;
        metadata?: { count: number };
      };

      for (const wl of response.results ?? []) {
        allWorklogs.push({
          tempoWorklogId: wl.tempoWorklogId,
          issueId: wl.issue?.id ?? wl.issueId ?? 0,
          startDate: wl.startDate,
          timeSpentSeconds: wl.timeSpentSeconds,
        });
      }

      const meta = response.metadata;
      if (!meta || offset + limit >= meta.count) break;
      offset += limit;
    }

    return allWorklogs;
  }

  /**
   * Day schedule of the token's user (requiredSeconds, day type, holiday).
   * Needs scope schemes:view — 403 without it. Not paginated: the endpoint
   * takes only from/to and returns every day of the range.
   */
  public async getUserSchedule(from: string, to: string): Promise<TempoScheduleDay[]> {
    const response = await this.request('GET', `/4/user-schedule?from=${from}&to=${to}`) as {
      results?: TempoScheduleDay[];
    };
    return response.results ?? [];
  }

  /**
   * Current timesheet approval for the period containing `from` (period
   * granularity comes from globalconfiguration.approvalPeriod). Needs scope
   * approvals:view — 403 without it.
   */
  public async getUserTimesheetApproval(accountId: string, from: string): Promise<TempoTimesheetApproval> {
    const path = `/4/timesheet-approvals/user/${encodeURIComponent(accountId)}?from=${from}`;
    return await this.request('GET', path) as TempoTimesheetApproval;
  }

  /** Fetch all work attributes (e.g. _Activity_ STATIC_LIST values). */
  public async getWorkAttributes(): Promise<TempoWorkAttribute[]> {
    const response = await this.request('GET', '/4/work-attributes?limit=100') as {
      results?: TempoWorkAttribute[];
    };
    return response.results ?? [];
  }

  /** Build the shared worklog body. activity defaults to Development; description omitted when empty. */
  private buildWorklogBody(params: CreateWorklogParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      issueId: params.issueId,
      authorAccountId: params.authorAccountId,
      timeSpentSeconds: params.timeSpentSeconds,
      startDate: params.startDate,
      startTime: '09:00:00',
      attributes: [{ key: ACTIVITY_ATTRIBUTE_KEY, value: params.activity ?? DEFAULT_ACTIVITY }],
    };
    if (params.description) body.description = params.description;
    return body;
  }

  /** Create a new worklog */
  public async createWorklog(params: CreateWorklogParams): Promise<{ tempoWorklogId: number }> {
    return this.request('POST', '/4/worklogs', this.buildWorklogBody(params)) as Promise<{ tempoWorklogId: number }>;
  }

  /** Update an existing worklog */
  public async updateWorklog(worklogId: number, params: CreateWorklogParams): Promise<{ tempoWorklogId: number }> {
    return this.request('PUT', `/4/worklogs/${worklogId}`, this.buildWorklogBody(params)) as Promise<{ tempoWorklogId: number }>;
  }

  /** Delete a worklog */
  public async deleteWorklog(worklogId: number): Promise<void> {
    await this.request('DELETE', `/4/worklogs/${worklogId}`);
  }
}
