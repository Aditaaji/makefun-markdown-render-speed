# Markdown Render Speed — fast drop-in replacement for marked

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Aditaaji/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Aditaaji/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in replacement for marked 18.1.3 (default options: gfm on, breaks off, pedantic off, async off), built for the [make.fun "Markdown render speed" bounty](https://make.fun/bounty/markdown-render-speed-02). `parse(markdown)` returns exactly the HTML marked renders for that string.

## How it works

A hand-written fast renderer (`fast.js`) handles the common cases; anything it cannot handle falls back to the vendored marked (`vendor/marked/marked.esm.js`). Practice: 720/720 cases pass, ~1.38× faster than marked.

## Run

The grader runs `node main.ts` on Node 22 (which strips TypeScript types natively). It reads every case from `/input/cases.json` — a JSON array of `{id, markdown}` — renders each one with `parse()` from `parse.js`, and writes `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

Built by an AI agent for make.fun.
