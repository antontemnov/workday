import { Injectable } from '@angular/core';
import { WorkdayApiService } from './workday-api.service';

export interface RepoAddOutcome {
  // Latest repo list from the daemon; null when nothing was added.
  readonly repos: readonly string[] | null;
  readonly added: number;
  readonly error: string | null;
}

const PICKER_TITLE = 'Select repositories or a folder with projects';
const PROMPT_TEXT = 'Absolute path to a git repository or a folder with projects:';
const CONFIRM_LIST_LIMIT = 15;

/**
 * The "+ add" flow shared by Settings and the setup wizard: pick one or many
 * folders, let the daemon expand root folders into the repos inside, confirm
 * a scan result, then add everything.
 */
@Injectable({ providedIn: 'root' })
export class RepoPickerService {
  public constructor(private api: WorkdayApiService) {}

  /** Null when the user cancelled. */
  public async pickAndAdd(): Promise<RepoAddOutcome | null> {
    const picked = await this.pickPaths();
    if (picked.length === 0) return null;

    const resolved = await this.api.resolveRepos(picked);
    // A daemon without the resolve endpoint still adds picked repos one by one.
    let targets: readonly string[] = picked;
    if (resolved.ok && resolved.data) {
      const data = resolved.data;
      targets = data.repos;
      if (targets.length === 0) {
        const error = data.alreadyAdded > 0 ? 'Already added' : 'No git repositories found';
        return { repos: null, added: 0, error };
      }
      if (data.scanned && !(await this.confirmScan(targets, data.truncated))) return null;
    }

    let repos: readonly string[] | null = null;
    let added = 0;
    let error: string | null = null;
    for (const path of targets) {
      const res = await this.api.addRepo(path);
      if (res.ok && res.data) {
        repos = res.data.repos;
        added++;
      } else {
        error ??= res.error ?? 'Failed to add repository';
      }
    }
    return { repos, added, error };
  }

  private async pickPaths(): Promise<readonly string[]> {
    if (this.isInTauri()) {
      try {
        // Dynamic import keeps the browser bundle from failing to resolve the
        // plugin module in mock / dev-server mode.
        const dialog = await import('@tauri-apps/plugin-dialog');
        const selected = await dialog.open({ directory: true, multiple: true, title: PICKER_TITLE });
        if (selected === null) return [];
        return Array.isArray(selected) ? selected : [selected];
      } catch (e) {
        console.error('Folder picker failed', e);
      }
    }
    const typed = window.prompt(PROMPT_TEXT)?.trim();
    return typed ? [typed] : [];
  }

  private async confirmScan(repos: readonly string[], truncated: boolean): Promise<boolean> {
    const names = repos.slice(0, CONFIRM_LIST_LIMIT).map(path => `  ${path}`);
    if (repos.length > CONFIRM_LIST_LIMIT) names.push(`  … and ${repos.length - CONFIRM_LIST_LIMIT} more`);
    const noun = repos.length === 1 ? 'repository' : 'repositories';
    const lines = [`Found ${repos.length} git ${noun}:`, '', ...names];
    if (truncated) lines.push('', 'The folder is large — the search stopped early, some repositories may be missing.');
    lines.push('', 'Add them all?');
    const message = lines.join('\n');

    if (this.isInTauri()) {
      try {
        const dialog = await import('@tauri-apps/plugin-dialog');
        return await dialog.ask(message, { title: 'Add repositories', kind: 'info' });
      } catch (e) {
        console.error('Confirm dialog failed', e);
      }
    }
    return window.confirm(message);
  }

  private isInTauri(): boolean {
    return !!(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  }
}
