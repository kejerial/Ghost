/** A small semaphore. It caps how many model subprocesses run at once. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    // A finishing task hands its slot straight to the next waiter, so `active` never drops
    // below the true count and a new caller cannot slip in between.
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  get pending(): number {
    return this.waiting.length;
  }
}
