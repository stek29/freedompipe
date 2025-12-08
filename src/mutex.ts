class MutexTimeoutError extends Error {
  constructor() {
    super("Sync already in progress");
  }
}

class Mutex {
  #locked = false;
  #waiting: Array<() => void> = [];

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return this.#makeRelease();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        this.#locked = true;
        resolve(this.#makeRelease());
      };

      let wrappedGrant = grant;
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          const idx = this.#waiting.indexOf(wrappedGrant);
          if (idx >= 0) this.#waiting.splice(idx, 1);
          reject(new MutexTimeoutError());
        }, timeoutMs);
        wrappedGrant = () => {
          clearTimeout(timer);
          grant();
        };
      }

      this.#waiting.push(wrappedGrant);
    });
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) {
        next();
      } else {
        this.#locked = false;
      }
    };
  }
}

export { Mutex, MutexTimeoutError };
