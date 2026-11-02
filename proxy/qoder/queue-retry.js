import {setTimeout as sleep} from 'node:timers/promises';

// Reserve separate retry slots for callers sharing an account and model.
// Only rejected, pre-output requests enter this queue; successful streams do not.
export class QueueRetry {
  constructor({now = Date.now, wait = sleep} = {}) {
    this.now = now;
    this.wait = wait;
    this.slots = new Map();
  }
  async delay(key, delayMs, signal) {
    signal?.throwIfAborted();
    const now = this.now();
    for (const [key, at] of this.slots) if (at <= now) this.slots.delete(key);
    const previous = this.slots.get(key);
    const at = Math.max(now, previous || 0) + delayMs;
    this.slots.set(key, at);
    try {
      await this.wait(at - now, undefined, {signal});
      signal?.throwIfAborted();
    } catch (error) {
      if (this.slots.get(key) === at) {
        if (previous > this.now()) this.slots.set(key, previous);
        else this.slots.delete(key);
      }
      throw error;
    } finally {
      if (this.slots.get(key) === at && at <= this.now()) this.slots.delete(key);
    }
  }
}
