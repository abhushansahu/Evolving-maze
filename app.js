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
  highestScoreLabel: document.getElementById("highestScoreLabel"),
  wallCountLabel: document.getElementById("wallCountLabel"),
  shortestLabel: document.getElementById("shortestLabel"),
  pawnPolicyLabel: document.getElementById("pawnPolicyLabel"),
  adaptiveConfidenceLabel: document.getElementById("adaptiveConfidenceLabel"),
  message: document.getElementById("message"),
  endWallTurnBtn: document.getElementById("endWallTurnBtn"),
  undoBtn: document.getElementById("undoBtn"),
  resetBtn: document.getElementById("resetBtn"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
  downloadJsonlBtn: document.getElementById("downloadJsonlBtn"),
  strategyFileInput: document.getElementById("strategyFileInput"),
  loadStrategyBtn: document.getElementById("loadStrategyBtn"),
  playStrategyTurnBtn: document.getElementById("playStrategyTurnBtn"),
  toggleStrategyAutoBtn: document.getElementById("toggleStrategyAutoBtn"),
  policyVizHint: document.getElementById("policyVizHint"),
  strategyStatus: document.getElementById("strategyStatus"),
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

const strategyRunner = {
  actions: null,
  sourceName: "",
  autoEnabled: false,
};

const PAWN_POLICY = {
  ADAPTIVE: "adaptive",
  GREEDY: "greedy",
  ROBUST: "robust",
};

const pawnPolicy = {
  mode: PAWN_POLICY.ADAPTIVE,
  selectedMode: PAWN_POLICY.ROBUST,
  reason: "Initialized with robust preference.",
  confidencePct: 50,
  scoreDelta: 0,
};

const wallPolicy = {
  selectedMode: "robust",
  reason: "Initialized with robust preference.",
  confidencePct: 50,
  highestScoreEstimate: 0,
  abandonedDeadlocks: 0,
};

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

function validPawnMovesFrom(pos, wallSet = game.walls) {
  return neighbors(pos).filter((n) => !hasWallBetween(pos, n, wallSet));
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

function buildCanonicalShortestPathEdgesFrom(start, distanceMap, wallSet = game.walls) {
  const startDistance = distanceMap.get(cellId(start));
  if (!Number.isFinite(startDistance)) return new Set();

  const pathEdges = new Set();
  const cursor = { ...start };
  while (cursor.x !== game.goal.x || cursor.y !== game.goal.y) {
    const currentDistance = distanceMap.get(cellId(cursor));
    let next = null;
    for (const n of neighbors(cursor)) {
      if (hasWallBetween(cursor, n, wallSet)) continue;
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
    pathEdges.add(edgeKey(cursor, next));
    cursor.x = next.x;
    cursor.y = next.y;
  }
  return pathEdges;
}

function getDistanceColor(distance, maxDistance) {
  if (!Number.isFinite(distance)) return "#e2e8f0";
  if (maxDistance <= 0) return "hsl(130, 70%, 68%)";
  const ratio = Math.max(0, Math.min(1, distance / maxDistance));
  const hue = 120 - ratio * 120;
  return `hsl(${hue}, 75%, 78%)`;
}

function formatDistance(distance) {
  return Number.isFinite(distance) ? String(distance) : "∞";
}

function getPawnPolicyDisplayName() {
  if (pawnPolicy.mode === PAWN_POLICY.ADAPTIVE) {
    const selected = pawnPolicy.selectedMode === PAWN_POLICY.GREEDY ? "Greedy" : "Robust";
    return `Adaptive (auto -> ${selected})`;
  }
  return pawnPolicy.mode === PAWN_POLICY.ROBUST ? "Robust (lookahead)" : "Greedy (1-step)";
}

function getPawnTrail(limit = 10) {
  const trail = game.log
    .filter((entry) => entry.actor === TURN.PAWN_PUSHER && entry.action === "move_pawn")
    .map((entry) => ({ x: entry.pawn.x, y: entry.pawn.y }));
  trail.push({ ...game.pawn });
  return trail.slice(-limit);
}

function estimateLoopRiskForMove(candidateMove, candidateDistance) {
  const trail = getPawnTrail(10);
  const recent = trail.slice(-8);
  const candidateId = cellId(candidateMove);
  const currentId = cellId(game.pawn);
  const previousId = recent.length >= 2 ? cellId(recent[recent.length - 2]) : null;

  const repeatCount = recent.filter((pos) => cellId(pos) === candidateId).length;
  const repeatRisk = Math.min(1, repeatCount / 3);
  const backtrackRisk = previousId && previousId === candidateId ? 1 : 0;

  const recentMoveEntries = game.log
    .filter((entry) => entry.actor === TURN.PAWN_PUSHER && entry.action === "move_pawn")
    .slice(-6);
  const recentDistances = recentMoveEntries
    .map((entry) => (Number.isFinite(entry.shortestPath) ? entry.shortestPath : Infinity))
    .filter((d) => Number.isFinite(d));
  const bestRecentDistance = recentDistances.length > 0 ? Math.min(...recentDistances) : candidateDistance;
  const stagnationRisk = candidateDistance > bestRecentDistance ? Math.min(1, (candidateDistance - bestRecentDistance) / 3) : 0;

  // Penalize staying in same local pocket with little net progress.
  const localPocketRisk = recent.filter((pos) => Math.abs(pos.x - game.pawn.x) + Math.abs(pos.y - game.pawn.y) <= 1).length >= 5 ? 0.35 : 0;
  const idempotentRisk = candidateId === currentId ? 1 : 0;

  const risk = Math.min(
    1,
    repeatRisk * 0.35 + backtrackRisk * 0.35 + stagnationRisk * 0.2 + localPocketRisk + idempotentRisk
  );
  return risk;
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

function setStrategyStatus(text) {
  elements.strategyStatus.textContent = text;
}

function parseEdgeKeyToEndpoints(key) {
  const [left, right] = key.split("|");
  const [ax, ay] = left.split(",").map((v) => Number(v));
  const [bx, by] = right.split(",").map((v) => Number(v));
  if ([ax, ay, bx, by].some((v) => Number.isNaN(v))) return null;
  return {
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
  };
}

function normalizeAction(action) {
  if (action == null) return null;
  if (typeof action !== "string") return null;
  const endpoints = parseEdgeKeyToEndpoints(action);
  if (!endpoints) return null;
  return edgeKey(endpoints.a, endpoints.b);
}

function loadStrategyFromPayload(payload, sourceName = "loaded JSON") {
  let actions = null;
  if (Array.isArray(payload?.actions)) {
    actions = payload.actions.map((action) => normalizeAction(action));
  } else if (Array.isArray(payload?.exactStatePolicy)) {
    actions = payload.exactStatePolicy.map((item) => normalizeAction(item?.action));
  }

  if (!actions) {
    throw new Error("Expected `actions` or `exactStatePolicy` array in strategy JSON.");
  }

  strategyRunner.actions = actions;
  strategyRunner.sourceName = sourceName;
  setStrategyStatus(`Strategy loaded (${actions.length} turns) from ${sourceName}.`);
  elements.toggleStrategyAutoBtn.textContent = `Auto Strategy: ${strategyRunner.autoEnabled ? "On" : "Off"} (JSON)`;
  updateUI();
}

function loadStrategyFromFile() {
  const file = elements.strategyFileInput.files?.[0];
  if (!file) {
    setMessage("Choose a strategy JSON file first.");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => setMessage("Failed to read strategy file.");
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result));
      loadStrategyFromPayload(payload, file.name);
      setMessage("Strategy file loaded.");
    } catch (error) {
      setMessage(`Could not parse strategy file: ${error.message}`);
    }
  };
  reader.readAsText(file);
}

function applyWallByEdgeKey(key, reason = "strategy_auto_wall") {
  const endpoints = parseEdgeKeyToEndpoints(key);
  if (!endpoints) return false;
  if (game.walls.has(key)) return false;

  const testSet = new Set(game.walls);
  testSet.add(key);
  if (!hasPathToGoal(testSet)) return false;

  saveUndoSnapshot();
  game.walls.add(key);
  addLogEntry(TURN.WALL_SETTER, "place_wall", {
    from: endpoints.a,
    to: endpoints.b,
    edgeKey: key,
  });
  endWallTurn(reason, { saveSnapshot: false });
  return true;
}

function applyStrategyTurn({ forceEvenIfAuto = false } = {}) {
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  if (!forceEvenIfAuto) return;

  if (!strategyRunner.actions) {
    applyAdaptiveWallSetterTurn();
    return;
  }

  const turnIndex = game.score;
  const action = strategyRunner.actions[turnIndex] ?? null;
  if (action == null) {
    endWallTurn("strategy_pass");
    setMessage(`Strategy turn ${turnIndex + 1}: pass.`);
    return;
  }

  const placed = applyWallByEdgeKey(action, "strategy_wall");
  if (!placed) {
    endWallTurn("strategy_illegal_fallback_pass");
    setMessage(`Strategy wall ${action} was unavailable/illegal; passed instead.`);
    return;
  }
}

function toggleStrategyAuto() {
  strategyRunner.autoEnabled = !strategyRunner.autoEnabled;
  const status = strategyRunner.autoEnabled ? "On" : "Off";
  const source = strategyRunner.actions ? "JSON" : "Adaptive";
  elements.toggleStrategyAutoBtn.textContent = `Auto Strategy: ${status} (${source})`;
  if (strategyRunner.autoEnabled && game.turn === TURN.WALL_SETTER && !game.gameOver) {
    setTimeout(() => applyStrategyTurn({ forceEvenIfAuto: true }), 40);
  }
  updateUI();
}

function setButtonsEnabled() {
  const isWallTurn = game.turn === TURN.WALL_SETTER && !game.gameOver;
  elements.endWallTurnBtn.disabled = !isWallTurn;
  elements.undoBtn.disabled = history.length === 0;
  elements.playStrategyTurnBtn.disabled = !isWallTurn;
  elements.toggleStrategyAutoBtn.disabled = false;
}

function renderBoard() {
  elements.board.innerHTML = "";
  const distanceMap = computeDistanceMapToGoal();
  const pathCells = buildShortestPathCellsFrom(game.pawn, distanceMap);
  const moveInsights = getPawnMoveInsights();
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

      const moveInsight = moveInsights.insights.get(id);
      if (moveInsight) {
        cell.classList.add("pawn-option");
        if (id === moveInsights.bestMoveId) {
          cell.classList.add("pawn-option-recommended");
        }
      }

      const distanceLabel = document.createElement("span");
      distanceLabel.className = "distance-label";
      distanceLabel.textContent = formatDistance(distance);
      cell.appendChild(distanceLabel);

      if (moveInsight) {
        const moveScoreLabel = document.createElement("span");
        moveScoreLabel.className = "move-score-label";
        moveScoreLabel.textContent = `W${formatDistance(moveInsight.worstDistance)}/D${formatDistance(moveInsight.greedyDistance)}/L${Math.round(moveInsight.loopRisk * 100)}`;
        cell.appendChild(moveScoreLabel);
      }

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

function buildAllEdgeKeys() {
  const keys = [];
  // Vertical walls between (x,y) and (x+1,y)
  for (let y = 1; y <= GRID_SIZE; y += 1) {
    for (let x = 1; x < GRID_SIZE; x += 1) {
      keys.push(edgeKey({ x, y }, { x: x + 1, y }));
    }
  }
  // Horizontal walls between (x,y) and (x,y+1)
  for (let y = 1; y < GRID_SIZE; y += 1) {
    for (let x = 1; x <= GRID_SIZE; x += 1) {
      keys.push(edgeKey({ x, y }, { x, y: y + 1 }));
    }
  }
  return keys;
}

const ALL_EDGE_KEYS = buildAllEdgeKeys();

function compareTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function evaluateWorstWallResponseForPawn(pawnPos, wallSet = game.walls) {
  const baseDistanceMap = computeDistanceMapToGoal(wallSet);
  const baseDistance = baseDistanceMap.get(cellId(pawnPos)) ?? Infinity;
  const baseMobility = validPawnMovesFrom(pawnPos, wallSet).length;

  // Wall-Setter can always effectively "pass", so include no-wall baseline.
  let worstForPawn = [baseDistance, -baseMobility];
  for (const key of ALL_EDGE_KEYS) {
    if (wallSet.has(key)) continue;
    const testSet = new Set(wallSet);
    testSet.add(key);

    // Wall placement must keep a path for the current pawn position.
    if (!Number.isFinite(shortestPathLength(pawnPos, game.goal, testSet))) continue;

    const distanceMap = computeDistanceMapToGoal(testSet);
    const remainingDistance = distanceMap.get(cellId(pawnPos)) ?? Infinity;
    const mobility = validPawnMovesFrom(pawnPos, testSet).length;
    const candidateForWallSetter = [remainingDistance, -mobility];
    if (compareTuple(candidateForWallSetter, worstForPawn) > 0) {
      worstForPawn = candidateForWallSetter;
    }
  }
  return worstForPawn;
}

function chooseGreedyPawnMove() {
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

function chooseRobustPawnMove() {
  const validMoves = currentValidPawnMoves();
  if (validMoves.length === 0) return null;

  let bestMove = validMoves[0];
  let bestScore = null;

  for (const candidate of validMoves) {
    const worstWallResponse = evaluateWorstWallResponseForPawn(candidate, game.walls);
    const manhattan = Math.abs(candidate.x - game.goal.x) + Math.abs(candidate.y - game.goal.y);
    const candidateScore = [...worstWallResponse, manhattan];
    if (!bestScore || compareTuple(candidateScore, bestScore) < 0) {
      bestScore = candidateScore;
      bestMove = candidate;
    }
  }

  return bestMove;
}

function chooseModeFromInsights(insights, bestGreedyId, bestRobustId) {
  if (!bestGreedyId && !bestRobustId) {
    return {
      mode: PAWN_POLICY.ROBUST,
      bestMoveId: null,
      reason: "No legal pawn moves.",
      confidencePct: 50,
      scoreDelta: 0,
    };
  }
  if (!bestGreedyId) {
    return {
      mode: PAWN_POLICY.ROBUST,
      bestMoveId: bestRobustId,
      reason: "Only robust candidate available.",
      confidencePct: 92,
      scoreDelta: 9,
    };
  }
  if (!bestRobustId) {
    return {
      mode: PAWN_POLICY.GREEDY,
      bestMoveId: bestGreedyId,
      reason: "Only greedy candidate available.",
      confidencePct: 92,
      scoreDelta: 9,
    };
  }

  const greedyBest = insights.get(bestGreedyId);
  const robustBest = insights.get(bestRobustId);
  if (!greedyBest || !robustBest) {
    return {
      mode: PAWN_POLICY.ROBUST,
      bestMoveId: bestRobustId,
      reason: "Fallback to robust due to missing insight.",
      confidencePct: 60,
      scoreDelta: 1,
    };
  }

  const greedyCost =
    greedyBest.worstDistance * 5 + greedyBest.greedyDistance * 1.5 - greedyBest.worstMobility * 0.6 + greedyBest.loopRisk * 12;
  const robustCost =
    robustBest.worstDistance * 5 + robustBest.greedyDistance * 1.5 - robustBest.worstMobility * 0.6 + robustBest.loopRisk * 12;

  const chooseGreedy = greedyCost < robustCost;
  const chosen = chooseGreedy ? greedyBest : robustBest;
  const selectedMode = chooseGreedy ? PAWN_POLICY.GREEDY : PAWN_POLICY.ROBUST;
  const bestMoveId = chooseGreedy ? bestGreedyId : bestRobustId;

  const scoreDelta = Math.abs(greedyCost - robustCost);
  const baseConfidence = Math.min(95, 50 + scoreDelta * 8);
  const confidencePct = Math.max(51, Math.round(baseConfidence - chosen.loopRisk * 25));

  const reason = chooseGreedy
    ? chosen.loopRisk >= 0.45
      ? "Switched to greedy due to elevated loop risk under robust."
      : "Switched to greedy: lower combined risk-speed score."
    : chosen.loopRisk <= 0.25
      ? "Stayed robust: low loop risk with safer worst-case outlook."
      : "Stayed robust: despite loop risk, robust still scores better.";

  return {
    mode: selectedMode,
    bestMoveId,
    reason,
    confidencePct,
    scoreDelta: Number(scoreDelta.toFixed(2)),
  };
}

function chooseOptimalPawnMove() {
  const analysis = getPawnMoveInsights();
  const bestMove = analysis.bestMoveId ? analysis.insights.get(analysis.bestMoveId)?.move ?? null : null;
  pawnPolicy.selectedMode = analysis.selectedMode;
  pawnPolicy.reason = analysis.reason;
  pawnPolicy.confidencePct = analysis.confidencePct;
  pawnPolicy.scoreDelta = analysis.scoreDelta;
  return bestMove;
}

function getPawnMoveInsights() {
  const validMoves = currentValidPawnMoves();
  const distanceMap = computeDistanceMapToGoal();
  const insights = new Map();
  let bestGreedyId = null;
  let bestGreedyScore = null;
  let bestRobustId = null;
  let bestRobustScore = null;

  for (const candidate of validMoves) {
    const candidateId = cellId(candidate);
    const greedyDistance = distanceMap.get(candidateId) ?? Infinity;
    const [worstDistance, negWorstMobility] = evaluateWorstWallResponseForPawn(candidate, game.walls);
    const loopRisk = estimateLoopRiskForMove(candidate, greedyDistance);
    const manhattan = Math.abs(candidate.x - game.goal.x) + Math.abs(candidate.y - game.goal.y);
    const greedyScore = [greedyDistance, manhattan];
    const robustScore = [worstDistance, negWorstMobility, manhattan];

    insights.set(candidateId, {
      move: candidate,
      greedyDistance,
      worstDistance,
      worstMobility: -negWorstMobility,
      loopRisk,
      greedyScore,
      robustScore,
    });

    if (!bestGreedyScore || compareTuple(greedyScore, bestGreedyScore) < 0) {
      bestGreedyScore = greedyScore;
      bestGreedyId = candidateId;
    }
    if (!bestRobustScore || compareTuple(robustScore, bestRobustScore) < 0) {
      bestRobustScore = robustScore;
      bestRobustId = candidateId;
    }
  }

  if (pawnPolicy.mode === PAWN_POLICY.GREEDY) {
    return {
      insights,
      bestGreedyId,
      bestRobustId,
      bestMoveId: bestGreedyId,
      selectedMode: PAWN_POLICY.GREEDY,
      reason: "Manual greedy mode.",
      confidencePct: 100,
      scoreDelta: 0,
    };
  }
  if (pawnPolicy.mode === PAWN_POLICY.ROBUST) {
    return {
      insights,
      bestGreedyId,
      bestRobustId,
      bestMoveId: bestRobustId,
      selectedMode: PAWN_POLICY.ROBUST,
      reason: "Manual robust mode.",
      confidencePct: 100,
      scoreDelta: 0,
    };
  }

  const adaptive = chooseModeFromInsights(insights, bestGreedyId, bestRobustId);

  return {
    insights,
    bestGreedyId,
    bestRobustId,
    bestMoveId: adaptive.bestMoveId,
    selectedMode: adaptive.mode,
    reason: adaptive.reason,
    confidencePct: adaptive.confidencePct,
    scoreDelta: adaptive.scoreDelta,
  };
}

function chooseAdaptiveWallMode(baseDistance) {
  const moveInsights = getPawnMoveInsights();
  const selectedInsight = moveInsights.bestMoveId ? moveInsights.insights.get(moveInsights.bestMoveId) : null;
  const loopRisk = selectedInsight?.loopRisk ?? 0;
  if (baseDistance <= 7 && loopRisk < 0.55) {
    return {
      mode: "aggressive",
      reason: "Pawn is closer to goal, so maximize immediate delay.",
      confidencePct: Math.max(55, Math.round(88 - loopRisk * 30)),
    };
  }
  return {
    mode: "robust",
    reason: "Deadlock-safe stalling mode with safer mobility.",
    confidencePct: Math.max(55, Math.round(82 - loopRisk * 25)),
  };
}

function evaluateAdaptiveWallCandidate(key, baseDistance, shortestPathEdges, mode) {
  if (game.walls.has(key)) return null;
  const testSet = new Set(game.walls);
  testSet.add(key);
  if (!hasPathToGoal(testSet)) return null;

  const distanceAfterWall = shortestPathLength(game.pawn, game.goal, testSet);
  if (!Number.isFinite(distanceAfterWall)) return null;

  const mobilityAfterWall = validPawnMovesFrom(game.pawn, testSet).length;
  const distanceGain = distanceAfterWall - baseDistance;
  const blocksCanonicalPath = shortestPathEdges.has(key);

  const lowMobilityRisk = mobilityAfterWall <= 1 ? 1 : mobilityAfterWall === 2 ? 0.45 : 0;
  const stagnantPocketRisk = mobilityAfterWall <= 2 && distanceGain <= 0 ? 0.6 : 0;
  const deadlockRisk = Math.min(1, lowMobilityRisk + stagnantPocketRisk);
  if (deadlockRisk >= 0.95) return { abandonedDeadlock: true };

  const aggressiveUtility =
    distanceAfterWall * 8 +
    distanceGain * 5 +
    (blocksCanonicalPath ? 4 : 0) -
    mobilityAfterWall * 1.2 -
    deadlockRisk * 24;

  const robustUtility =
    distanceAfterWall * 6 +
    distanceGain * 2.8 +
    (blocksCanonicalPath ? 2.2 : 0) +
    mobilityAfterWall * 0.7 -
    deadlockRisk * 30;

  return {
    key,
    utility: mode === "aggressive" ? aggressiveUtility : robustUtility,
    distanceAfterWall,
    distanceGain,
    mobilityAfterWall,
    blocksCanonicalPath,
    projectedHighestScore: game.score + Math.max(1, distanceAfterWall),
  };
}

function chooseAdaptiveWallAction() {
  const baseDistance = shortestPathLength(game.pawn, game.goal, game.walls);
  const distanceMap = computeDistanceMapToGoal();
  const shortestPathEdges = buildCanonicalShortestPathEdgesFrom(game.pawn, distanceMap, game.walls);
  const modeSelection = chooseAdaptiveWallMode(baseDistance);

  let bestCandidate = null;
  let abandonedDeadlocks = 0;
  for (const key of ALL_EDGE_KEYS) {
    const candidate = evaluateAdaptiveWallCandidate(key, baseDistance, shortestPathEdges, modeSelection.mode);
    if (!candidate) {
      continue;
    }
    if (candidate.abandonedDeadlock) {
      abandonedDeadlocks += 1;
      continue;
    }
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    const candidateTuple = [
      candidate.utility,
      candidate.distanceAfterWall,
      candidate.distanceGain,
      candidate.blocksCanonicalPath ? 1 : 0,
      -candidate.mobilityAfterWall,
    ];
    const bestTuple = [
      bestCandidate.utility,
      bestCandidate.distanceAfterWall,
      bestCandidate.distanceGain,
      bestCandidate.blocksCanonicalPath ? 1 : 0,
      -bestCandidate.mobilityAfterWall,
    ];
    if (compareTuple(candidateTuple, bestTuple) > 0) {
      bestCandidate = candidate;
    }
  }

  return {
    mode: modeSelection.mode,
    reason: modeSelection.reason,
    confidencePct: modeSelection.confidencePct,
    abandonedDeadlocks,
    bestCandidate,
    highestScoreEstimate: bestCandidate
      ? bestCandidate.projectedHighestScore
      : game.score + (Number.isFinite(baseDistance) ? baseDistance : 0),
  };
}

function applyAdaptiveWallSetterTurn() {
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  const decision = chooseAdaptiveWallAction();
  wallPolicy.selectedMode = decision.mode;
  wallPolicy.reason = decision.reason;
  wallPolicy.confidencePct = decision.confidencePct;
  wallPolicy.highestScoreEstimate = decision.highestScoreEstimate;
  wallPolicy.abandonedDeadlocks = decision.abandonedDeadlocks;

  const action = decision.bestCandidate?.key ?? null;
  if (!action) {
    endWallTurn("adaptive_deadlock_safe_pass");
    return;
  }
  const placed = applyWallByEdgeKey(action, "adaptive_wall");
  if (!placed) {
    endWallTurn("adaptive_illegal_fallback_pass");
  }
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
  if (!game.gameOver && strategyRunner.autoEnabled && game.turn === TURN.WALL_SETTER) {
    setTimeout(() => applyStrategyTurn({ forceEvenIfAuto: true }), 40);
  }
}

function updateStatusPanel() {
  if (!strategyRunner.actions && game.turn === TURN.WALL_SETTER && !game.gameOver) {
    const decision = chooseAdaptiveWallAction();
    wallPolicy.selectedMode = decision.mode;
    wallPolicy.reason = decision.reason;
    wallPolicy.confidencePct = decision.confidencePct;
    wallPolicy.highestScoreEstimate = decision.highestScoreEstimate;
    wallPolicy.abandonedDeadlocks = decision.abandonedDeadlocks;
  } else if (!strategyRunner.actions) {
    const shortestNow = shortestPathLength(game.pawn, game.goal);
    wallPolicy.highestScoreEstimate = game.score + (Number.isFinite(shortestNow) ? shortestNow : 0);
  } else {
    const shortestNow = shortestPathLength(game.pawn, game.goal);
    wallPolicy.reason = "Using loaded JSON strategy.";
    wallPolicy.abandonedDeadlocks = 0;
    wallPolicy.highestScoreEstimate = game.score + (Number.isFinite(shortestNow) ? shortestNow : 0);
  }

  const moveInsights = getPawnMoveInsights();
  pawnPolicy.selectedMode = moveInsights.selectedMode;
  pawnPolicy.reason = moveInsights.reason;
  pawnPolicy.confidencePct = moveInsights.confidencePct;
  pawnPolicy.scoreDelta = moveInsights.scoreDelta;

  elements.turnLabel.textContent = game.gameOver ? "Game ended" : game.turn;
  elements.pawnLabel.textContent = `(${game.pawn.x}, ${game.pawn.y})`;
  elements.scoreLabel.textContent = String(game.score);
  elements.highestScoreLabel.textContent = String(wallPolicy.highestScoreEstimate);
  elements.wallCountLabel.textContent = String(game.walls.size);
  const shortest = shortestPathLength(game.pawn, game.goal);
  elements.shortestLabel.textContent = Number.isFinite(shortest) ? String(shortest) : "No path";
  elements.pawnPolicyLabel.textContent = getPawnPolicyDisplayName();
  elements.adaptiveConfidenceLabel.textContent = `${pawnPolicy.confidencePct}% (delta ${pawnPolicy.scoreDelta})`;
  elements.policyVizHint.textContent =
    `Visualization: blue-ringed adjacent cell is the adaptive pawn recommendation (${pawnPolicy.selectedMode}). ` +
    "Each adjacent option shows W/D/L where W is worst-case distance, D is immediate distance, and L is loop-risk %. " +
    `Pawn reason: ${pawnPolicy.reason} Wall reason: ${wallPolicy.reason} ` +
    `(deadlock abandons: ${wallPolicy.abandonedDeadlocks}).`;
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
  wallPolicy.selectedMode = "robust";
  wallPolicy.reason = "Initialized with robust preference.";
  wallPolicy.confidencePct = 50;
  wallPolicy.highestScoreEstimate = shortestPathLength(game.pawn, game.goal);
  wallPolicy.abandonedDeadlocks = 0;
  addLogEntry("System", "game_start", {
    boardSize: GRID_SIZE,
    start: { x: 1, y: 1 },
    goal: { x: 10, y: 10 },
  });
  setMessage("Wall-Setter starts. Place one legal wall (auto-end) or press Space to pass.");
  if (strategyRunner.actions) {
    setStrategyStatus(
      `Strategy loaded (${strategyRunner.actions.length} turns) from ${strategyRunner.sourceName || "JSON"}.`
    );
    elements.toggleStrategyAutoBtn.textContent = `Auto Strategy: ${strategyRunner.autoEnabled ? "On" : "Off"} (JSON)`;
  } else {
    setStrategyStatus("No JSON loaded. Adaptive Wall-Setter strategy is active.");
    elements.toggleStrategyAutoBtn.textContent = `Auto Strategy: ${strategyRunner.autoEnabled ? "On" : "Off"} (Adaptive)`;
  }
  updateUI();
  if (strategyRunner.autoEnabled) {
    setTimeout(() => applyStrategyTurn({ forceEvenIfAuto: true }), 40);
  }
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
elements.loadStrategyBtn.addEventListener("click", loadStrategyFromFile);
elements.playStrategyTurnBtn.addEventListener("click", () => applyStrategyTurn({ forceEvenIfAuto: true }));
elements.toggleStrategyAutoBtn.addEventListener("click", toggleStrategyAuto);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  const activeTag = document.activeElement?.tagName || "";
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
  if (game.turn !== TURN.WALL_SETTER || game.gameOver) return;
  event.preventDefault();
  endWallTurn("manual_pass_space");
});

resetGame();
