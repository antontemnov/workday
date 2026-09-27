/**
 * Git stamps reflog entries in whole seconds and GitTracker reports only the
 * entries strictly newer than the last one it has seen — an operation landing
 * in the same second as an entry an earlier tick already read is never
 * reported. Await this before a git operation the next tick must see: it
 * resolves once the wall clock is inside the next second (plus a margin for
 * git reading a coarser clock than Node).
 */
const CLOCK_MARGIN_MS = 100;

export async function waitForNextReflogSecond(): Promise<void> {
  const target = (Math.floor(Date.now() / 1000) + 1) * 1000 + CLOCK_MARGIN_MS;
  while (Date.now() < target) {
    await new Promise<void>(resolve => setTimeout(resolve, target - Date.now()));
  }
}
