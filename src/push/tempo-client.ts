import { TEMPO_BASE_URL, TEMPO_RATE_LIMIT_MS } from '../core/constants.js';
import type { TempoWorklog } from '../core/types.js';

interface CreateWorklogParams {
  readonly issueId: number;
  readonly authorAccountId: string;
  readonly timeSpentSeconds: number;
  readonly startDate: string;
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
      throw new Error(`Tempo API ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
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

  /** Create a new worklog */
  public async createWorklog(params: CreateWorklogParams): Promise<{ tempoWorklogId: number }> {
    const body: Record<string, unknown> = {
      issueId: params.issueId,
      authorAccountId: params.authorAccountId,
      timeSpentSeconds: params.timeSpentSeconds,
      startDate: params.startDate,
      startTime: '09:00:00',
      attributes: [{ key: '_Activity_', value: 'Development' }],
    };
    return this.request('POST', '/4/worklogs', body) as Promise<{ tempoWorklogId: number }>;
  }

  /** Update an existing worklog */
  public async updateWorklog(worklogId: number, params: CreateWorklogParams): Promise<{ tempoWorklogId: number }> {
    const body: Record<string, unknown> = {
      issueId: params.issueId,
      authorAccountId: params.authorAccountId,
      timeSpentSeconds: params.timeSpentSeconds,
      startDate: params.startDate,
      startTime: '09:00:00',
      attributes: [{ key: '_Activity_', value: 'Development' }],
    };
    return this.request('PUT', `/4/worklogs/${worklogId}`, body) as Promise<{ tempoWorklogId: number }>;
  }

  /** Delete a worklog */
  public async deleteWorklog(worklogId: number): Promise<void> {
    await this.request('DELETE', `/4/worklogs/${worklogId}`);
  }
}
