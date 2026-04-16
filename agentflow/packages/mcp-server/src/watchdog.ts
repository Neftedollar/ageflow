/**
 * Fires a callback after `maxDurationSec` elapses and signals abortion via AbortController.
 *
 * - null maxDurationSec = no watchdog (unlimited).
 * - cancel() stops the timer and releases resources (used on successful completion).
 */
export class DurationWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controller = new AbortController();

  constructor(
    private readonly maxDurationSec: number | null,
    private readonly onTimeout: () => void,
  ) {}

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.maxDurationSec === null) return;
    this.timer = setTimeout(() => {
      this.controller.abort();
      this.onTimeout();
    }, this.maxDurationSec * 1000);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
