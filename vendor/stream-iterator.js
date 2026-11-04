// Safari doesn't let you loop over a ReadableStream with `for await` (Chrome and Firefox do). The phonemizer
// unpacks its dictionary that way as soon as it loads, so add it here. Imported before the phonemizer: ES
// modules run in import order, so this is in place by the time the phonemizer's code runs.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
