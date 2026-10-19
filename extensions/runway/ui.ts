import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

export async function showRunwayDetails(ctx: ExtensionContext, lines: string[]): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0, pageSize = 1, maxOffset = 0;
    return {
      invalidate() {},
      render(width: number) {
        const text = new Text(lines.slice(1).map(line => theme.fg(line.startsWith("Action:") ? "accent" : "muted", line)).join("\n"), 1, 0);
        const body = text.render(width);
        pageSize = Math.max(1, Math.floor(tui.terminal.rows * 0.7) - 2);
        maxOffset = Math.max(0, body.length - pageSize);
        offset = Math.min(offset, maxOffset);
        return [
          truncateToWidth(theme.fg("accent", lines[0] ?? "RUNWAY"), width),
          ...body.slice(offset, offset + pageSize),
          truncateToWidth(theme.fg("dim", `↑↓ / PgUp/PgDn scroll · Enter/Esc close · ${offset + 1}–${Math.min(body.length, offset + pageSize)}/${body.length}`), width),
        ];
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "ctrl+c")) { done(); return; }
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "down")) offset = Math.min(maxOffset, offset + 1);
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageSize);
        else if (matchesKey(data, "pageDown")) offset = Math.min(maxOffset, offset + pageSize);
        else return;
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } });
}
