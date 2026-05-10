const GRID_SIZE = 10;
const CELL_SIZE = 50;

const TURN = {
  WALL_SETTER: "Wall-Setter",
  PAWN_PUSHER: "Pawn-Pusher",
};

const elements = {
  board: document.getElementById("board"),
  turnLabel: document.getElementById("turnLabel"),
  pawnLabel: document.getElementById("pawnLabel"),
  scoreLabel: document.getElementById("scoreLabel"),
  wallCountLabel: document.getElementById("wallCountLabel"),
  shortestLabel: document.getElementById("shortestLabel"),
  message: document.getElementById("message"),
  endWallTurnBtn: document.getElementById("endWallTurnBtn"),
  undoBtn: document.getElementById("undoBtn"),
  resetBtn: document.getElementById("resetBtn"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
  downloadJsonlBtn: document.getElementById("downloadJsonlBtn"),
};

const game = {
  pawn: { x: 1, y: 1 },
  goal: { x: GRID_SIZE, y: GRID_SIZE },
  turn: TURN.WALL_SETTER,
  score: 0,
  walls: new Set(),
  gameOver: false,
  log: [],
  ply: 0,
};

const history = [];
let autoMoveTimerId = null;

function clearAutoMoveTimer() {
  if (autoMoveTimerId !== null) {
    clearTimeout(autoMoveTimerId);
    autoMoveTimerId = null;
  }
}

function snapshotState() {
  return {
    pawn: { ...game.pawn },
    turn: game.turn,
    score: game.score,
    walls: Array.from(game.walls),
    gameOver: game.gameOver,
    log: JSON.parse(JSON.stringify(game.log)),
    ply: game.ply,
    message: elements.message.textContent,
  };
}

function restoreState(state) {
  game.pawn = { ...state.pawn };
  game.turn = state.turn;
  game.score = state.score;
  game.walls = new Set(state.walls);
  game.gameOver = state.gameOver;
  game.log = JSON.parse(JSON.stringify(state.log));
  game.ply = state.ply;
  setMessage(state.message || "");
  updateUI();
}

function saveUndoSnapshot() {
  history.push(snapshotState());
}

function undoLastAction() {
  if (history.length === 0) {
    setMessage("Nothing to undo.");
    return;
  }
  clearAutoMoveTimer();
  const previous = history.pop();
  restoreState(previous);
  setMessage("Undid last action.");
}

function edgeKey(a, b) {
  const p = `${a.x},${a.y}`;
  const q = `${b.x},${b.y}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
}

function inBounds(x, y) {
  return x >= 1 && x <= GRID_SIZE && y >= 1 && y <= GRID_SIZE;
}

function neighbors(pos) {
  return [
    { x: pos.x + 1, y: pos.y },
    { x: pos.x - 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 },
    { x: pos.x, y: pos.y - 1 },
  ].filter((p) => inBounds(p.x, p.y));
}

function hasWallBetween(a, b, wallSet = game.walls) {
  return wallSet.has(edgeKey(a, b));
}

function shortestPathLength(start, goal, wallSet = game.walls) {
  const queue = [{ ...start, d: 0 }];
  const visited = new Set([`${start.x},${start.y}`]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.x === goal.x && current.y === goal.y) {
      return current.d;
    }
    for (const n of neighbors(current)) {
      if (hasWallBetween(current, n, wallSet)) continue;
      const id = `${n.x},${n.y}`;
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push({ ...n, d: current.d + 1 });
    }
  }
  return Infinity;
}

function hasPathToGoal(wallSet = game.walls) {
  return Number.isFinite(shortestPathLength(game.pawn, game.goal, wallSet));
}

function currentValidPawnMoves() {
  return neighbors(game.pawn).filter((n) => !hasWallBetween(game.pawn, n));
}

function cellId(pos) {
  return `${pos.x},${pos.y}`;
}

function computeDistanceMapToGoal(wallSet = game.walls) {
  const queue = [{ ...game.goal, d: 0 }];
  const distanceMap = new Map([[cellId(game.goal), 0]]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const n of neighbors(current)) {
      if (hasWallBetween(current, n, wallSet)) continue;
      const id = cellId(n);
      if (distanceMap.has(id)) continue;
      const nextDistance = current.d + 1;
      distanceMap.set(id, nextDistance);
      queue.push({ ...n, d: nextDistance });
    }
  }
  return distanceMap;
}

function buildShortestPathCellsFrom(start, distanceMap) {
  const startDistance = distanceMap.get(cellId(start));
  if (!Number.isFinite(startDistance)) return new Set();

  const pathCells = new Set([cellId(start)]);
  const cursor = { ...start };
  while (cursor.x !== game.goal.x || cursor.y !== game.goal.y) {
    const currentDistance = distanceMap.get(cellId(cursor));
    let next = null;
    for (const n of neighbors(cursor)) {
      if (hasWallBetween(cursor, n)) continue;
      const d = distanceMap.get(cellId(n));
      if (!Number.isFinite(d) || d !== currentDistance - 1) continue;
      if (!next) {
        next = n;
        continue;
      }
      const nextManhattan = Math.abs(next.x - game.goal.x) + Math.abs(next.y - game.goal.y);
      const candidateManhattan = Math.abs(n.x - game.goal.x) + Math.abs(n.y - game.goal.y);
      if (candidateManhattan < nextManhattan) {
        next = n;
      }
    }
    if (!next) break;
    pathCells.add(cellId(next));
    cursor.x = next.x;
    cursor.y = next.y;
  }
  return pathCells;
}

function getDistanceColor(distance, maxDistance) {
  if (!Number.isFinite(distance)) return "#e2e8f0";
  if (maxDistance <= 0) return "hsl(130, 70%, 68%)";
  const ratio = Math.max(0, Math.min(1, distance / maxDistance));
  const hue = 120 - ratio * 120;
  return `hsl(${hue}, 75%, 78%)`;
}

function addLogEntry(actor, action, details = {}) {
  game.ply += 1;
  const shortest = shortestPathLength(game.pawn, game.goal);
  const entry = {
    ply: game.ply,
    timestamp: new Date().toISOString(),
    actor,
    action,
    details,
    pawn: { ...game.pawn },
    score: game.score,
    turnNext: game.turn,
    wallCount: game.walls.size,
    shortestPath: Number.isFinite(shortest) ? shortest : null,
    validPawnMoves: currentValidPawnMoves(),
    walls: Array.from(game.walls),
  };
  game.log.push(entry);
}

function setMessage(text) {
  elements.message.textContent = text;
}

function setButtonsEnabled() {
  const isWallTurn = game.turn === TURN.WALL_SETTER && !game.gameOver;
  elements.endWallTurnBtn.disabled = !isWallTurn;
  elements.undoBtn.disabled = history.length === 0;
}

function renderBoard() {
  elements.board.innerHTML = "";
  const distanceMap = computeDistanceMapToGoal();
  const pathCells = buildShortestPathCellsFrom(game.pawn, distanceMap);
  const reachableDistances = Array.from(distanceMap.values());
  const maxDistance = reachableDistances.length > 0 ? Math.max(...reachableDistances) : 0;

  for (let y = 1; y <= GRID_SIZE; y += 1) {
    for (let x = 1; x <= GRID_SIZE; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.width = `${CELL_SIZE}px`;
      cell.style.height = `${CELL_SIZE}px`;
      cell.style.left = `${(x - 1) * CELL_SIZE}px`;
      cell.style.top = `${(y - 1) * CELL_SIZE}px`;
      const id = `${x},${y}`;
      const distance = distanceMap.get(id);
      cell.style.background = getDistanceColor(distance, maxDistance);

      if (!Number.isFinite(distance)) {
        cell.classList.add("unreachable");
      }

      if (x === game.goal.x && y === game.goal.y) {
        cell.classList.add("goal");
      }

      if (pathCells.has(id)) {
        cell.classList.add("shortest-path-cell");
      }

      const distanceLabel = document.createElement("span");
      distanceLabel.className = "distance-label";
      distanceLabel.textContent = Number.isFinite(distance) ? String(distance) : "∞";
      cell.appendChild(distanceLabel);

      if (x === game.pawn.x && y === game.pawn.y) {
        const pawn = document.createElement("div");
        pawn.className = "pawn";
        cell.appendChild(pawn);
      }

      elements.board.appendChild(cell);
    }
  }

  renderEdges();
}

function renderEdges() {
  // Vertical walls between (x,y) and (x+1,y)
  for (let y = 1; y <= GRID_SIZE; y += 1) {
    for (let x = 1; x < GRID_SIZE; x += 1) {
      const a = { x, y };
      const b = { x: x + 1, y };
      const key = edgeKey(a, b);
      const edge = document.createElement("button");
      edge.className = "edge vertical";
      if (game.walls.has(key)) edge.classList.add("wall");
      edge.style.left = `${x * CELL_SIZE - 4}px`;
      edge.style.top = `${(y - 1) * CELL_SIZE + 2}px`;
      edge.style.height = `${CELL_SIZE - 4}px`;
      edge.title = `Wall between (${a.x},${a.y}) and (${b.x},${b.y})`;

      edge.disabled = game.turn !== TURN.WALL_SETTER || game.gameOver;
      edge.addEventListener("click", () => attemptPlaceWall(a, b, key, edge));
      elements.board.appendChild(edge);
    }
  }

  // Horizontal walls between (x,y) and (x,y+1)
  for (let y = 1; y < GRID_SIZE; y += 1) {
    for (let x = 1; x <= GRID_SIZE; x += 1) {
      const a = { x, y };
      const b = { x, y: y + 1 };
      const key = edgeKey(a, b);
      const edge = document.createElement("button");
      edge.className = "edge horizontal";
      if (game.walls.has(key)) edge.classList.add("wall");
      edge.style.left = `${(x - 1) * CELL_SIZE + 2}px`;
      edge.style.top = `${y * CELL_SIZE - 4}px`;
      edge.style.width = `${CELL_SIZE - 4}px`;
      edge.title = `Wall between (${a.x},${a.y}) and (${b.x},${b.y})`;

      edge.disabled = game.turn !== TURN.WALL_SETTER || game.gameOver;
      edge.addEventListener("click", () => attemptPlaceWall(a, b, key, edge));
      elements.board.appendChild(edge);
    }
  }
}

function attemptPlaceWall(a, b, key, edgeElement) {
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  if (game.walls.has(key)) {
    setMessage("That wall already exists.");
    return;
  }

  const testSet = new Set(game.walls);
  testSet.add(key);
  if (!hasPathToGoal(testSet)) {
    edgeElement.classList.add("preview");
    setTimeout(() => edgeElement.classList.remove("preview"), 200);
    setMessage("Illegal wall: it would block all paths to (10, 10).");
    return;
  }

  saveUndoSnapshot();
  game.walls.add(key);
  addLogEntry(TURN.WALL_SETTER, "place_wall", { from: a, to: b, edgeKey: key });
  endWallTurn("wall_placed_auto", { saveSnapshot: false });
}

function chooseOptimalPawnMove() {
  const validMoves = currentValidPawnMoves();
  if (validMoves.length === 0) return null;
  const distanceMap = computeDistanceMapToGoal();

  let bestMove = validMoves[0];
  let bestDistance = distanceMap.get(cellId(bestMove)) ?? Infinity;
  for (let i = 1; i < validMoves.length; i += 1) {
    const candidate = validMoves[i];
    const candidateDistance = distanceMap.get(cellId(candidate)) ?? Infinity;
    if (candidateDistance < bestDistance) {
      bestMove = candidate;
      bestDistance = candidateDistance;
      continue;
    }
    if (candidateDistance === bestDistance) {
      const currentManhattan = Math.abs(bestMove.x - game.goal.x) + Math.abs(bestMove.y - game.goal.y);
      const candidateManhattan = Math.abs(candidate.x - game.goal.x) + Math.abs(candidate.y - game.goal.y);
      if (candidateManhattan < currentManhattan) {
        bestMove = candidate;
      }
    }
  }
  return bestMove;
}

function performAutoPawnMove() {
  if (game.turn !== TURN.PAWN_PUSHER || game.gameOver) return;
  const bestMove = chooseOptimalPawnMove();
  if (!bestMove) {
    setMessage("No legal pawn move available.");
    return;
  }
  movePawnTo(bestMove, { auto: true });
}

function endWallTurn(reason = "manual_pass", options = {}) {
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  if (options.saveSnapshot !== false) {
    saveUndoSnapshot();
  }
  game.turn = TURN.PAWN_PUSHER;
  addLogEntry(TURN.WALL_SETTER, "end_turn", { reason });
  setMessage("Pawn-Pusher is choosing an optimal move...");
  updateUI();
  autoMoveTimerId = setTimeout(() => {
    autoMoveTimerId = null;
    performAutoPawnMove();
  }, 120);
}

function movePawnTo(target, options = {}) {
  if (game.turn !== TURN.PAWN_PUSHER || game.gameOver) return;
  const isAdjacent = Math.abs(game.pawn.x - target.x) + Math.abs(game.pawn.y - target.y) === 1;
  if (!isAdjacent) {
    setMessage("Invalid move: must move exactly one step.");
    return;
  }
  if (hasWallBetween(game.pawn, target)) {
    setMessage("Invalid move: wall blocks that direction.");
    return;
  }
  saveUndoSnapshot();
  game.pawn = { ...target };
  game.score += 1;
  addLogEntry(TURN.PAWN_PUSHER, "move_pawn", { to: target });

  if (game.pawn.x === game.goal.x && game.pawn.y === game.goal.y) {
    game.gameOver = true;
    addLogEntry("System", "game_end", { finalScore: game.score });
    setMessage(`Game over. Pawn reached goal in ${game.score} moves.`);
  } else {
    game.turn = TURN.WALL_SETTER;
    const movedBy = options.auto ? "Auto pawn move complete." : "Pawn move complete.";
    setMessage(`${movedBy} Wall-Setter turn: place one legal wall or press Space to pass.`);
  }

  updateUI();
}

function updateStatusPanel() {
  elements.turnLabel.textContent = game.gameOver ? "Game ended" : game.turn;
  elements.pawnLabel.textContent = `(${game.pawn.x}, ${game.pawn.y})`;
  elements.scoreLabel.textContent = String(game.score);
  elements.wallCountLabel.textContent = String(game.walls.size);
  const shortest = shortestPathLength(game.pawn, game.goal);
  elements.shortestLabel.textContent = Number.isFinite(shortest) ? String(shortest) : "No path";
}

function updateUI() {
  updateStatusPanel();
  renderBoard();
  setButtonsEnabled();
}

function resetGame() {
  clearAutoMoveTimer();
  game.pawn = { x: 1, y: 1 };
  game.turn = TURN.WALL_SETTER;
  game.score = 0;
  game.walls = new Set();
  game.gameOver = false;
  game.log = [];
  game.ply = 0;
  history.length = 0;
  addLogEntry("System", "game_start", {
    boardSize: GRID_SIZE,
    start: { x: 1, y: 1 },
    goal: { x: 10, y: 10 },
  });
  setMessage("Wall-Setter starts. Place one legal wall (auto-end) or press Space to pass.");
  updateUI();
}

function triggerDownload(filename, data, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadJson() {
  const payload = {
    rules: {
      gridSize: GRID_SIZE,
      start: { x: 1, y: 1 },
      goal: { x: 10, y: 10 },
    },
    finalState: {
      pawn: game.pawn,
      score: game.score,
      gameOver: game.gameOver,
      wallCount: game.walls.size,
    },
    turns: game.log,
  };
  triggerDownload("wall-pawn-game-log.json", JSON.stringify(payload, null, 2), "application/json");
}

function downloadJsonl() {
  const lines = game.log.map((entry) => JSON.stringify(entry));
  triggerDownload("wall-pawn-game-log.jsonl", `${lines.join("\n")}\n`, "application/x-ndjson");
}

elements.endWallTurnBtn.addEventListener("click", endWallTurn);
elements.undoBtn.addEventListener("click", undoLastAction);
elements.resetBtn.addEventListener("click", resetGame);
elements.downloadJsonBtn.addEventListener("click", downloadJson);
elements.downloadJsonlBtn.addEventListener("click", downloadJsonl);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  const activeTag = document.activeElement?.tagName || "";
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  event.preventDefault();
  endWallTurn("manual_pass_space");
});

resetGame();
