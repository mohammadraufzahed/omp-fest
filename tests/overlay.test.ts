import { describe, expect, it, vi } from "vitest";

import { CardComponent, showCard, type OverlayUiLike } from "../src/adapters/omp/overlay.js";

describe("CardComponent", () => {
  const make = (lines: string[], done = vi.fn()) =>
    new CardComponent({ title: "t", lines }, done);

  it("renders a bordered card with title and footer", () => {
    const rows = make(["a", "b"]).render(40);
    expect(rows[0]).toContain("╭");
    expect(rows[0]).toContain(" t ");
    expect(rows.at(-1)).toContain("╰");
    expect(rows.at(-1)).toContain("esc/q close");
    expect(rows.length).toBe(4); // top border + 2 lines + bottom border
  });

  it("scrolls with j/k and clamps at the ends", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const c = new CardComponent({ title: "t", lines, pageSize: 3 }, vi.fn());
    c.handleInput("j");
    c.handleInput("j");
    let rows = c.render(40);
    expect(rows.join("\n")).toContain("line2");
    expect(rows.join("\n")).not.toContain("line0");
    c.handleInput("k");
    c.handleInput("k");
    c.handleInput("k"); // clamps at 0
    rows = c.render(40);
    expect(rows.join("\n")).toContain("line0");
    c.handleInput("G"); // end
    rows = c.render(40);
    expect(rows.join("\n")).toContain("line9");
    c.handleInput("j"); // clamps at max
    expect(c.render(40).join("\n")).toContain("line9");
  });

  it("closes on esc, q, enter and ctrl+c", () => {
    for (const key of ["\u001b", "q", "\r", "\u0003"]) {
      const done = vi.fn();
      const card = new CardComponent({ title: "t", lines: [] }, done);
      card.handleInput(key);
      expect(done).toHaveBeenCalledWith("closed");
    }
  });
});

describe("showCard", () => {
  it("returns false when ui.custom is missing", async () => {
    expect(await showCard({}, { title: "t", lines: [] })).toBe(false);
  });

  it("returns false when custom resolves undefined (headless shim)", async () => {
    const ui: OverlayUiLike = { custom: () => Promise.resolve(undefined) };
    expect(await showCard(ui, { title: "t", lines: [] })).toBe(false);
  });

  it("returns true when the card is closed via done", async () => {
    const ui: OverlayUiLike = {
      custom: <T>(
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
        options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
      ) => {
        expect(options?.overlay).toBe(true);
        let result: T | undefined;
        const component = factory(null, null, null, (r: T) => {
          result = r;
        }) as CardComponent;
        component.handleInput("q");
        return Promise.resolve(result);
      },
    };
    expect(await showCard(ui, { title: "t", lines: ["x"] })).toBe(true);
  });
});
