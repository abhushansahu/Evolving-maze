# Wall-Setter vs Pawn-Pusher

Simple browser game for the 10x10 wall-placement puzzle with:

- Turn-by-turn play (`Wall-Setter` then auto `Pawn-Pusher`)
- Rule validation (no wall can remove all paths to goal)
- Score tracking (pawn moves made)
- Live shortest-path visualization with distance heatmap
- Training logs downloadable as JSON and JSONL

## Run

Open `index.html` in a browser.

## Controls

- Click one edge to place a legal wall. The wall turn ends automatically.
- If you want to place no wall, click `Pass Wall-Setter Turn` or press `Space`.
- Pawn-Pusher automatically chooses the adjacent move that minimizes shortest remaining path to `(10,10)`.
- Use `Undo` to step back one action at a time.

## Suggested strategy ideas

### Wall-Setter

- **Delay committing corridors:** Keep many options open early, then shape walls around the pawn's current area.
- **Force local detours repeatedly:** Walls that add 1-2 moves over several turns are often stronger than a single dramatic block.
- **Cut near the pawn, not only near the goal:** Re-routing immediately around the pawn can force them to spend moves before making net progress.
- **Protect bottlenecks:** If a narrow passage appears, avoid placing walls that accidentally create an alternate short route.
- **Think in shortest-path delta:** Before placing a wall, estimate whether shortest path length increases. Prefer walls with positive delta.

### Pawn-Pusher

- **Follow shortest-path opportunities:** If a wall doesn't increase shortest path, keep moving on direct lines to `(10,10)`.
- **Avoid self-trapping regions:** Enter open central lanes unless a side lane is clearly still short.
- **Exploit Wall-Setter's legal constraint:** They can never fully trap you, so search for the current least-constrained route every turn.
- **Minimize wall reaction surface:** Staying near boundaries can reduce the number of edges that can be used to detour you.
- **Move quickly after weak wall turns:** If Wall-Setter passes or gains little, convert that immediately into positional progress.

## Logging format

Each event includes:

- `ply`, `timestamp`, `actor`, `action`
- `details` (action-specific payload)
- board state snapshot (`pawn`, `walls`, `validPawnMoves`)
- scalar metrics (`score`, `shortestPath`, `wallCount`)

This structure is useful for offline policy training or evaluation pipelines.
