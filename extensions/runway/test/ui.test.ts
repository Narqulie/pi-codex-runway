import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showRunwayDetails } from "../ui";

test("detail panel wraps, scrolls all content, resizes and closes without transcript output", async () => {
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const ctx: any = { mode: "tui", hasUI: true, ui: {
    notify: () => assert.fail("Terminal details must not produce a notification"),
    custom: async (factory: Function, options: any) => {
      assert.equal(options.overlay, true);
      for (const closeKey of ["\r", "\x1b", "\x03"]) {
        let closed = false;
        const panel = factory(tui, { fg: (_token: string, text: string) => text }, {}, () => { closed = true; });
        const initial = panel.render(40);
        assert.equal(initial[0], "RUNWAY");
        assert.ok(initial.every((line: string) => visibleWidth(line) <= 40));
        assert.ok(initial.length <= Math.floor(tui.terminal.rows * 0.7));
        assert.ok(!initial.join("\n").includes("LAST LINE"));
        panel.handleInput("\x1b[6~"); // Page Down
        assert.notDeepEqual(panel.render(40), initial);
        for (let i = 0; i < 100; i++) panel.handleInput("\x1b[B");
        assert.ok(panel.render(40).join("\n").includes("LAST LINE"));
        tui.terminal.rows = 12;
        assert.ok(panel.render(40).length <= Math.floor(12 * 0.7));
        tui.terminal.rows = 24;
        for (let i = 0; i < 30; i++) panel.handleInput("\x1b[5~"); // Page Up
        assert.deepEqual(panel.render(40), initial);
        panel.handleInput(closeKey);
        assert.equal(closed, true);
      }
    },
  } };
  await showRunwayDetails(ctx, ["RUNWAY", ...Array.from({ length: 30 }, (_, i) => `Line ${i} with wrapped quota details and 漢字`), "LAST LINE"]);
});

test("RPC gets requested details once; non-UI mode emits nothing", async () => {
  const notices: string[] = [];
  const ctx: any = { mode: "rpc", hasUI: true, ui: {
    notify: (text: string) => notices.push(text),
    custom: () => assert.fail("RPC does not support terminal panels"),
  } };
  await showRunwayDetails(ctx, ["RUNWAY", "Details"]);
  assert.deepEqual(notices, ["RUNWAY\nDetails"]);
  ctx.hasUI = false;
  await showRunwayDetails(ctx, ["RUNWAY", "Details"]);
  assert.equal(notices.length, 1);
});
