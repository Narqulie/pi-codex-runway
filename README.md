# Codex Runway for Pi

An adaptive, workday-based Codex weekly quota forecast for [Pi](https://github.com/badlogic/pi-mono).

It uses your own Codex quota percentage and reset time to answer: **at my current Monday–Friday pace, do I need to take care or slow down before reset?**

- Persists a local quota timeline from two-minute WHAM polls plus a compact forecast/alert decision history.
- Derives daily percentage burn, not token-price assumptions or model-response minutes.
- Calculates pace versus sustainable pace through the weekly reset.
- Advises `FREE`, `HEALTHY`, `ON BUDGET`, `TAKE CARE`, or `SLOW DOWN`.
- Never applies a hard daily cap. It confirms only expensive Sol/Fast-like work while `SLOW DOWN`.
- Keeps all data local: `~/.pi/agent/codex-runway.json`. No credentials or quota data leave your machine.

## Install

Requires Pi and an authenticated `openai-codex` provider.

```bash
pi install git:github.com/Narqulie/pi-codex-runway@v1.0.0
```

Restart Pi or run `/reload` after installation.

## Use

```text
/codex-runway
/codex-runway refresh
/codex-runway history
/codex-runway reserve 15
/codex-runway clear
```

The default schedule is Monday–Friday, 09:00–16:00 local time. Weekends have zero planned weight. A forecast begins after two usable workday pace samples; until then it deliberately reports `learning` rather than inventing a rate from small, whole-percent quota changes.

## How it works

```text
usableBudget = remainingPct - reservePct
sustainableBurnPerWorkday = usableBudget / remainingWeightedWorkdays
recentBurnPerWorkday = EWMA(completed daily burn / workday weight)
expectedFutureBurn = recentBurnPerWorkday × remainingWeightedWorkdays
paceRatio = recentBurnPerWorkday / sustainableBurnPerWorkday
```

| Pace ratio | Status | Action |
|---:|---|---|
| <0.75 | FREE | no warning |
| 0.75–0.90 | HEALTHY | normal work |
| 0.90–1.10 | ON BUDGET | monitor pace |
| 1.10–1.30 | TAKE CARE | prefer Terra/Luna for expensive tasks |
| >1.30 | SLOW DOWN | confirm expensive Sol/Fast-like tasks |

## Security and limitations

Extensions execute with your local user permissions. Review this repository before installation.

The included source reads your existing Pi Codex credential only to request the current quota from ChatGPT's WHAM endpoint; it does not transmit it anywhere else. WHAM reports whole percentage points, so short/intraday estimates are necessarily lower confidence.

## Development

```bash
/Users/narqulie/.pi/agent/npm/node_modules/.bin/tsx --test extensions/codex-runway/test/*.test.ts
pi -e ./
```

MIT licensed.
