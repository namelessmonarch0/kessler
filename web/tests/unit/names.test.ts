import { describe, expect, it, vi } from "vitest";
import { createNameCache } from "@/lib/names";

describe("name cache", () => {
  it("fetches a group once and serves it from memory", async () => {
    const fetcher = vi.fn(async () => ({ "25544": "ISS (ZARYA)" }));
    const c = createNameCache(fetcher);
    const [a, b] = await Promise.all([c.get("LEO"), c.get("LEO")]);
    expect(a?.get(25544)).toBe("ISS (ZARYA)");
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.peek("LEO")?.get(25544)).toBe("ISS (ZARYA)");
    expect(c.peek("HIGH")).toBeNull();
  });

  it("returns null on failure and retries after the cooldown", async () => {
    let t = 0;
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("404")).mockResolvedValue({ "1": "A" });
    const c = createNameCache(fetcher, () => t, 60_000);
    expect(await c.get("LEO")).toBeNull();
    t = 30_000;
    expect(await c.get("LEO")).toBeNull(); // still cooling down, no refetch
    expect(fetcher).toHaveBeenCalledTimes(1);
    t = 61_000;
    expect((await c.get("LEO"))?.get(1)).toBe("A");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
