// Meeting→ticket learning memory — memoization, not statistics: one accept
// teaches a series, because the signal is the user's own explicit pick.
// A single map serves every tier: level 1 looks up by uid, level 2 scans the
// same entries by titleKey, so the two can never disagree. The stored
// description is the learned DEVIATION only — an accepted default
// (== meeting title) is deliberately not stored, so the prefill keeps
// following the live title instead of freezing a stale snapshot.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './config.js';
import {
  MEETING_ASSOCIATIONS_FILE,
  MEETING_ASSOCIATION_RETENTION_DAYS,
  MEETING_MUTE_THRESHOLD,
  TMP_EXTENSION,
} from './constants.js';
import type { SuggestionCandidate, SuggestionResolved } from './types.js';

const DAY_MS = 86_400_000;

export interface MeetingAssociation {
  readonly task: string;
  readonly activity: string;
  readonly description?: string;  // learned deviation from the title default
  readonly titleKey: string;      // '' → excluded from the title tier (private, digit-only titles)
  readonly uses: number;          // accept count, informational
  readonly lastUsedAt: string;    // refreshed by accept/edit; drives prune and candidate order
}

export interface MeetingAssociations {
  readonly series: Record<string, MeetingAssociation>;
  readonly muted: Record<string, { readonly mutedAt: string }>;
  // Consecutive dismissed instances per series; reset by accept, promoted to
  // muted at MEETING_MUTE_THRESHOLD. Lives outside `series` because streaks
  // mostly belong to series the user never accepted.
  readonly streaks: Record<string, number>;
}

export function emptyMeetingAssociations(): MeetingAssociations {
  return { series: {}, muted: {}, streaks: {} };
}

/** lowercase → Unicode letters only (digits/dates/emoji/punctuation drop out)
 *  → unique tokens sorted, so word order and counters («#42») don't matter.
 *  '' for titles with no letters — the title tier just skips those. */
export function normalizeTitleKey(title: string): string {
  const tokens = title.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return [...new Set(tokens)].sort().join(' ');
}

/** Pure prune — exported for tests. Idle series entries expire; streaks of
 *  muted series are dropped (the mute already happened); mutes are a manual
 *  handbrake and never expire. */
export function pruneMeetingAssociations(all: MeetingAssociations, nowMs: number): MeetingAssociations {
  const cutoff = new Date(nowMs - MEETING_ASSOCIATION_RETENTION_DAYS * DAY_MS).toISOString();
  const series: Record<string, MeetingAssociation> = {};
  for (const [uid, assoc] of Object.entries(all.series)) {
    if (assoc.lastUsedAt >= cutoff) series[uid] = assoc;
  }
  const streaks: Record<string, number> = {};
  for (const [uid, count] of Object.entries(all.streaks)) {
    if (!all.muted[uid]) streaks[uid] = count;
  }
  return { series, muted: all.muted, streaks };
}

/** Load + prune in memory; the file compacts on the next write. */
export function loadMeetingAssociations(nowMs: number = Date.now()): MeetingAssociations {
  try {
    const parsed = JSON.parse(readFileSync(getAssociationsPath(), 'utf-8')) as Partial<MeetingAssociations>;
    if (parsed && typeof parsed === 'object') {
      return pruneMeetingAssociations({
        series: parsed.series ?? {},
        muted: parsed.muted ?? {},
        streaks: parsed.streaks ?? {},
      }, nowMs);
    }
  } catch { /* missing/corrupt → empty */ }
  return emptyMeetingAssociations();
}

// ─── Resolution ──────────────────────────────────────────────────────────

export interface SuggestionResolution {
  readonly resolved?: SuggestionResolved;
  readonly candidates?: readonly SuggestionCandidate[];
}

/** Four outcomes: uid hit → resolved(series); unanimous titleKey →
 *  resolved(title); conflicting titleKey → candidates (the conflict only —
 *  a wrong prefill blindly accepted would reach Tempo, so ambiguity asks);
 *  no match → {}. Private instances skip the title tier entirely: Outlook
 *  masks their titles to one shared string, which would cross-associate
 *  unrelated private series. */
export function resolveSuggestion(
  uid: string,
  title: string,
  isPrivate: boolean,
  associations: MeetingAssociations,
): SuggestionResolution {
  const direct = associations.series[uid];
  if (direct) return { resolved: toResolved(direct, 'series') };
  if (isPrivate) return {};
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) return {};

  const matches = Object.values(associations.series)
    .filter(a => a.titleKey === titleKey)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  if (matches.length === 0) return {};

  const distinctTasks = new Set(matches.map(a => a.task));
  if (distinctTasks.size === 1) return { resolved: toResolved(matches[0], 'title') };

  const candidates: SuggestionCandidate[] = [];
  for (const match of matches) {
    if (candidates.some(c => c.task === match.task)) continue;
    candidates.push({ task: match.task, activity: match.activity, lastUsedAt: match.lastUsedAt });
  }
  return { candidates };
}

function toResolved(assoc: MeetingAssociation, level: 'series' | 'title'): SuggestionResolved {
  const resolved: SuggestionResolved = { task: assoc.task, activity: assoc.activity, level };
  return assoc.description ? { ...resolved, description: assoc.description } : resolved;
}

// ─── Learning (accept / edit / dismiss side effects) ─────────────────────

export interface LearnAcceptInput {
  readonly uid: string;
  readonly title: string;
  readonly isPrivate: boolean;
  readonly task: string;
  readonly activity: string;
  readonly description: string;
  readonly nowMs?: number;
}

/** Accept side effect: upsert the association (last-write-wins, no
 *  refcounting), reset the dismiss streak. */
export function learnFromAccept(input: LearnAcceptInput): MeetingAssociation {
  const nowMs = input.nowMs ?? Date.now();
  const all = loadMeetingAssociations(nowMs);
  const learned = learnedDescription(input.description, input.title);
  const assoc: MeetingAssociation = {
    task: input.task,
    activity: input.activity,
    ...(learned ? { description: learned } : {}),
    titleKey: input.isPrivate ? '' : normalizeTitleKey(input.title),
    uses: (all.series[input.uid]?.uses ?? 0) + 1,
    lastUsedAt: new Date(nowMs).toISOString(),
  };
  const streaks = { ...all.streaks };
  delete streaks[input.uid];
  writeAssociations({ series: { ...all.series, [input.uid]: assoc }, muted: all.muted, streaks });
  return assoc;
}

export interface LearnEditInput {
  readonly uid: string;
  readonly task: string;          // entries never change task on edit — used only to recreate a lost association
  readonly activity: string;
  readonly description: string;
  // Live instance title when still cached; null → the deviation rule cannot
  // be applied, the stored description stays untouched.
  readonly title: string | null;
  readonly isPrivate: boolean;
  readonly nowMs?: number;
}

/** Edit side effect for entries carrying a meeting sourceRef: re-learn
 *  activity always, description by the deviation rule. */
export function learnFromEdit(input: LearnEditInput): void {
  const nowMs = input.nowMs ?? Date.now();
  const all = loadMeetingAssociations(nowMs);
  const prev = all.series[input.uid];
  const learned = input.title === null
    ? prev?.description
    : learnedDescription(input.description, input.title);
  const assoc: MeetingAssociation = {
    task: prev?.task ?? input.task,
    activity: input.activity,
    ...(learned ? { description: learned } : {}),
    titleKey: prev?.titleKey
      ?? (input.title === null || input.isPrivate ? '' : normalizeTitleKey(input.title)),
    uses: prev?.uses ?? 1,
    lastUsedAt: new Date(nowMs).toISOString(),
  };
  writeAssociations({ ...all, series: { ...all.series, [input.uid]: assoc } });
}

export interface DismissLearnResult {
  readonly muted: boolean;
  readonly streak: number;
}

/** Dismiss side effect: bump the consecutive-dismiss streak, mute the series
 *  at the threshold. The caller skips this for pushed days and for repeated
 *  dismisses of the same instance. */
export function registerDismiss(uid: string, nowMs: number = Date.now()): DismissLearnResult {
  const all = loadMeetingAssociations(nowMs);
  if (all.muted[uid]) return { muted: true, streak: 0 };
  const streak = (all.streaks[uid] ?? 0) + 1;
  if (streak >= MEETING_MUTE_THRESHOLD) {
    const streaks = { ...all.streaks };
    delete streaks[uid];
    writeAssociations({
      series: all.series,
      muted: { ...all.muted, [uid]: { mutedAt: new Date(nowMs).toISOString() } },
      streaks,
    });
    return { muted: true, streak };
  }
  writeAssociations({ ...all, streaks: { ...all.streaks, [uid]: streak } });
  return { muted: false, streak };
}

/** Manual handbrake release (CLI-only surface). Returns false when the
 *  series wasn't muted. */
export function unmuteSeries(uid: string): boolean {
  const all = loadMeetingAssociations();
  if (!all.muted[uid]) return false;
  const muted = { ...all.muted };
  delete muted[uid];
  writeAssociations({ ...all, muted });
  return true;
}

function learnedDescription(description: string, title: string): string | undefined {
  const trimmed = description.trim();
  return trimmed && trimmed !== title.trim() ? trimmed : undefined;
}

function getAssociationsPath(): string {
  return join(getDataDir(), MEETING_ASSOCIATIONS_FILE);
}

function writeAssociations(all: MeetingAssociations): void {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = getAssociationsPath();
  const tmpPath = path + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(all, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}
