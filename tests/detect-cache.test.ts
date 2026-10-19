import { describe, expect, it, vi } from "vitest";
import { CachedDetect } from "../src/application/detect-cache.js";
import type { CampLocation } from "../src/domain/types.js";
import type { CampDetect } from "../src/ports.js";

interface FakeDetect {
  detect: CampDetect;
  locateCalls: () => number;
}

function fakeDetect(): FakeDetect {
  let locateCalls = 0;
  const location: CampLocation = { kind: "camp-root", campRoot: "/camp", campName: "camp" };
  const detect: CampDetect = {
    locate: () => {
      locateCalls += 1;
      return Promise.resolve(location);
    },
    activeFestival: () => Promise.resolve("/camp/festivals/active/f-1"),
    listFestivals: () => Promise.resolve([]),
    progressFile: (dir) => `${dir}/.fest/progress_events.jsonl`,
    readProgress: () => Promise.resolve([]),
    pendingTasks: () => Promise.resolve([]),
    watch: () => () => undefined,
  };
  return { detect, locateCalls: () => locateCalls };
}

describe("CachedDetect", () => {
  it("memoizes locate within the TTL and bustCache refreshes", async () => {
    const inner = fakeDetect();
    const detect = new CachedDetect(inner.detect, 60_000);
    await detect.locate("/camp");
    await detect.locate("/camp");
    await detect.locate("/camp/other");
    expect(inner.locateCalls()).toBe(2);
    detect.bustCache();
    await detect.locate("/camp");
    expect(inner.locateCalls()).toBe(3);
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const inner = fakeDetect();
      const detect = new CachedDetect(inner.detect, 100);
      await detect.locate("/camp");
      vi.advanceTimersByTime(200);
      await detect.locate("/camp");
      expect(inner.locateCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
