/**
 * Floating overlay card for the omp TUI: `ui.custom` renders any Component —
 * we supply a self-contained bordered card (title, scrollable body, footer
 * hints) so `/fest show`, dashboards, and doctor float over the transcript
 * instead of dumping text. No pi-tui imports — render() returns styled rows
 * only, which keeps the plugin dependency-free.
 */

export interface OverlayUiLike {
  custom?<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
  ): Promise<T | undefined>;
}

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

export interface CardOptions {
  title: string;
  lines: string[];
  footer?: string;
  /** Rows of body shown at once; the rest scroll with j/k, arrows, PgUp/PgDn. */
  pageSize?: number;
}

export class CardComponent {
  focused = true;
  private offset = 0;
  private readonly pageSize: number;

  constructor(
    private readonly opts: CardOptions,
    private readonly done: (result: "closed") => void,
  ) {
    this.pageSize = Math.max(3, opts.pageSize ?? 20);
  }

  handleInput(data: string): void {
    const max = Math.max(0, this.opts.lines.length - this.pageSize);
    if (data === "\u001b" || data === "q" || data === "\r" || data === "\u0003") {
      this.done("closed");
      return;
    }
    if (data === "j" || data === "\u001b[B") {
      this.offset = Math.min(max, this.offset + 1);
    } else if (data === "k" || data === "\u001b[A") {
      this.offset = Math.max(0, this.offset - 1);
    } else if (data === "\u001b[6~" || data === " ") {
      this.offset = Math.min(max, this.offset + this.pageSize);
    } else if (data === "\u001b[5~") {
      this.offset = Math.max(0, this.offset - this.pageSize);
    } else if (data === "g") {
      this.offset = 0;
    } else if (data === "G") {
      this.offset = max;
    }
  }

  render(width: number): readonly string[] {
    const inner = Math.max(10, width - 4);
    const rows: string[] = [];
    const title = ` ${this.opts.title} `;
    rows.push(`${DIM}╭─${BOLD}${title}${RESET}${DIM}${"─".repeat(Math.max(0, inner - title.length - 1))}╮${RESET}`);
    const visible = this.opts.lines.slice(this.offset, this.offset + this.pageSize);
    for (const line of visible) {
      const text = line.length > inner ? `${line.slice(0, inner - 1)}…` : line;
      rows.push(`${DIM}│${RESET} ${text.padEnd(inner)}${DIM}│${RESET}`);
    }
    if (this.offset + this.pageSize < this.opts.lines.length || this.offset > 0) {
      const marker = `  ${this.offset > 0 ? "▲" : " "} ${this.offset + visible.length}/${this.opts.lines.length} ${this.offset + this.pageSize < this.opts.lines.length ? "▼" : " "}`;
      rows.push(`${DIM}│${RESET}${marker.padEnd(inner + 2)}${DIM}│${RESET}`);
    }
    const footer = ` ${this.opts.footer ?? "esc/q close · j/k scroll"} `;
    rows.push(`${DIM}╰─${footer}${"─".repeat(Math.max(0, inner - footer.length - 1))}╯${RESET}`);
    return rows;
  }
}

/**
 * Show lines in a floating card. Returns false when the host can't do
 * overlays (headless/RPC shim resolves undefined without calling the
 * factory) — callers then fall back to the plain transcript message.
 */
export async function showCard(ui: OverlayUiLike, opts: CardOptions): Promise<boolean> {
  if (typeof ui.custom !== "function") {
    return false;
  }
  const result = await ui.custom<"closed">(
    (_tui, _theme, _keybindings, done) => new CardComponent(opts, done),
    {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
    },
  );
  return result === "closed";
}
