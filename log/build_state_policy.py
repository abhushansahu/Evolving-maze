import argparse
import hashlib
import json
import random
from collections import deque
from dataclasses import dataclass
from statistics import mean
from typing import Dict, Iterable, List, Optional, Set, Tuple


GRID_SIZE = 10
START = (1, 1)
GOAL = (10, 10)
INF = 10**9
MAX_TURNS = 260
MAX_RESPONSE_CANDIDATES = 48

Edge = Tuple[Tuple[int, int], Tuple[int, int]]
Pos = Tuple[int, int]


def canonical_edge(a: Pos, b: Pos) -> Edge:
    return tuple(sorted((a, b)))


def edge_from_key(key: str) -> Edge:
    left, right = key.split("|")
    ax, ay = map(int, left.split(","))
    bx, by = map(int, right.split(","))
    return canonical_edge((ax, ay), (bx, by))


def edge_to_key(edge: Edge) -> str:
    (ax, ay), (bx, by) = edge
    return f"{ax},{ay}|{bx},{by}"


def all_edges() -> List[Edge]:
    edges = []
    for y in range(1, GRID_SIZE + 1):
        for x in range(1, GRID_SIZE):
            edges.append(canonical_edge((x, y), (x + 1, y)))
    for y in range(1, GRID_SIZE):
        for x in range(1, GRID_SIZE + 1):
            edges.append(canonical_edge((x, y), (x, y + 1)))
    return edges


ALL_EDGES = all_edges()


def neighbors(pos: Pos) -> List[Pos]:
    x, y = pos
    candidates = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return [(nx, ny) for nx, ny in candidates if 1 <= nx <= GRID_SIZE and 1 <= ny <= GRID_SIZE]


def shortest_distance_map(goal: Pos, walls: Set[Edge]) -> Dict[Pos, int]:
    queue = deque([goal])
    dist = {goal: 0}
    while queue:
        current = queue.popleft()
        for nxt in neighbors(current):
            if canonical_edge(current, nxt) in walls:
                continue
            if nxt in dist:
                continue
            dist[nxt] = dist[current] + 1
            queue.append(nxt)
    return dist


def shortest_path_length(start: Pos, walls: Set[Edge]) -> int:
    return shortest_distance_map(GOAL, walls).get(start, INF)


def has_path(start: Pos, walls: Set[Edge]) -> bool:
    return shortest_path_length(start, walls) < INF


def valid_pawn_moves(pos: Pos, walls: Set[Edge]) -> List[Pos]:
    return [nxt for nxt in neighbors(pos) if canonical_edge(pos, nxt) not in walls]


def manhattan(pos: Pos) -> int:
    return abs(pos[0] - GOAL[0]) + abs(pos[1] - GOAL[1])


def compare_tuple(a: Iterable[float], b: Iterable[float]) -> int:
    aa = list(a)
    bb = list(b)
    for x, y in zip(aa, bb):
        if x < y:
            return -1
        if x > y:
            return 1
    return 0


def state_hash(pawn: Pos, walls: Set[Edge]) -> str:
    wall_keys = sorted(edge_to_key(edge) for edge in walls)
    payload = json.dumps({"pawn": pawn, "walls": wall_keys}, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@dataclass
class PawnInsight:
    move: Pos
    greedy_distance: float
    worst_distance: float
    worst_mobility: int
    loop_risk: float
    greedy_score: Tuple[float, float]
    robust_score: Tuple[float, float, float]


@dataclass
class EvalResult:
    score: int
    reached_goal: bool
    wall_count: int
    fallback_count: int
    trajectory: List[Tuple[Pos, Set[Edge], Optional[Edge]]]


class StateBasedWallPolicy:
    def __init__(self, state_action_map: Dict[str, Optional[Edge]], template_edges: Set[Edge]):
        self.state_action_map = dict(state_action_map)
        self.template_edges = set(template_edges)

    def choose_action(self, pawn: Pos, walls: Set[Edge]) -> Tuple[Optional[Edge], str]:
        key = state_hash(pawn, walls)
        action = self.state_action_map.get(key)
        if action is not None or key in self.state_action_map:
            if action is None:
                return None, "exact"
            if action not in walls and has_path(pawn, walls | {action}):
                return action, "exact"

        fallback = choose_adaptive_wall_action(pawn, walls)
        return fallback, "fallback"


def evaluate_worst_wall_response_for_pawn(pawn_pos: Pos, walls: Set[Edge]) -> Tuple[float, float]:
    base_distance = shortest_path_length(pawn_pos, walls)
    base_mobility = len(valid_pawn_moves(pawn_pos, walls))
    worst_for_pawn = (float(base_distance), float(-base_mobility))

    candidate_edges: Set[Edge] = set(build_canonical_shortest_path_edges(pawn_pos, walls))
    frontier = {pawn_pos}
    frontier.update(valid_pawn_moves(pawn_pos, walls))
    for node in list(frontier):
        for nxt in neighbors(node):
            edge = canonical_edge(node, nxt)
            if edge not in walls:
                candidate_edges.add(edge)
    ordered_candidates = sorted(candidate_edges, key=edge_to_key)[:MAX_RESPONSE_CANDIDATES]

    for edge in ordered_candidates:
        if edge in walls:
            continue
        test_set = set(walls)
        test_set.add(edge)
        if not has_path(pawn_pos, test_set):
            continue
        remaining_distance = shortest_path_length(pawn_pos, test_set)
        mobility = len(valid_pawn_moves(pawn_pos, test_set))
        candidate = (float(remaining_distance), float(-mobility))
        if compare_tuple(candidate, worst_for_pawn) > 0:
            worst_for_pawn = candidate
    return worst_for_pawn


def estimate_loop_risk(
    candidate_move: Pos,
    candidate_distance: float,
    pawn_history: List[Pos],
    current_pawn: Pos,
    walls: Set[Edge],
) -> float:
    trail = pawn_history[-10:] + [current_pawn]
    recent = trail[-8:]

    repeat_count = sum(1 for p in recent if p == candidate_move)
    repeat_risk = min(1.0, repeat_count / 3.0)

    previous = recent[-2] if len(recent) >= 2 else None
    backtrack_risk = 1.0 if previous == candidate_move else 0.0

    recent_positions = pawn_history[-6:]
    recent_distances = []
    for pos in recent_positions:
        dist = shortest_path_length(pos, walls)
        if dist < INF:
            recent_distances.append(float(dist))
    best_recent_distance = min(recent_distances) if recent_distances else candidate_distance
    stagnation_risk = min(1.0, (candidate_distance - best_recent_distance) / 3.0) if candidate_distance > best_recent_distance else 0.0

    local_pocket_count = sum(1 for p in recent if abs(p[0] - current_pawn[0]) + abs(p[1] - current_pawn[1]) <= 1)
    local_pocket_risk = 0.35 if local_pocket_count >= 5 else 0.0
    idempotent_risk = 1.0 if candidate_move == current_pawn else 0.0

    risk = min(1.0, repeat_risk * 0.35 + backtrack_risk * 0.35 + stagnation_risk * 0.2 + local_pocket_risk + idempotent_risk)
    return risk


def get_pawn_move_insights(pawn: Pos, walls: Set[Edge], pawn_history: List[Pos]) -> Tuple[Dict[Pos, PawnInsight], Optional[Pos], Optional[Pos], Optional[Pos]]:
    valid = valid_pawn_moves(pawn, walls)
    if not valid:
        return {}, None, None, None

    dist_map = shortest_distance_map(GOAL, walls)
    insights: Dict[Pos, PawnInsight] = {}
    best_greedy_move: Optional[Pos] = None
    best_greedy_score: Optional[Tuple[float, float]] = None
    best_robust_move: Optional[Pos] = None
    best_robust_score: Optional[Tuple[float, float, float]] = None

    for candidate in valid:
        greedy_distance = float(dist_map.get(candidate, INF))
        worst_distance, neg_worst_mobility = evaluate_worst_wall_response_for_pawn(candidate, walls)
        loop_risk = estimate_loop_risk(candidate, greedy_distance, pawn_history, pawn, walls)
        g_score = (greedy_distance, float(manhattan(candidate)))
        r_score = (worst_distance, neg_worst_mobility, float(manhattan(candidate)))

        insights[candidate] = PawnInsight(
            move=candidate,
            greedy_distance=greedy_distance,
            worst_distance=worst_distance,
            worst_mobility=int(-neg_worst_mobility),
            loop_risk=loop_risk,
            greedy_score=g_score,
            robust_score=r_score,
        )

        if best_greedy_score is None or compare_tuple(g_score, best_greedy_score) < 0:
            best_greedy_score = g_score
            best_greedy_move = candidate
        if best_robust_score is None or compare_tuple(r_score, best_robust_score) < 0:
            best_robust_score = r_score
            best_robust_move = candidate

    if best_greedy_move is None:
        chosen = best_robust_move
    elif best_robust_move is None:
        chosen = best_greedy_move
    else:
        greedy = insights[best_greedy_move]
        robust = insights[best_robust_move]
        greedy_cost = greedy.worst_distance * 5 + greedy.greedy_distance * 1.5 - greedy.worst_mobility * 0.6 + greedy.loop_risk * 12
        robust_cost = robust.worst_distance * 5 + robust.greedy_distance * 1.5 - robust.worst_mobility * 0.6 + robust.loop_risk * 12
        chosen = best_greedy_move if greedy_cost < robust_cost else best_robust_move

    return insights, best_greedy_move, best_robust_move, chosen


def choose_optimal_pawn_move(pawn: Pos, walls: Set[Edge], pawn_history: List[Pos]) -> Optional[Pos]:
    _, _, _, chosen = get_pawn_move_insights(pawn, walls, pawn_history)
    return chosen


def build_canonical_shortest_path_edges(start: Pos, walls: Set[Edge]) -> Set[Edge]:
    dist_map = shortest_distance_map(GOAL, walls)
    if start not in dist_map:
        return set()

    path_edges: Set[Edge] = set()
    cursor = start
    while cursor != GOAL:
        current_distance = dist_map.get(cursor, INF)
        next_pos: Optional[Pos] = None
        for nxt in neighbors(cursor):
            if canonical_edge(cursor, nxt) in walls:
                continue
            d = dist_map.get(nxt, INF)
            if d != current_distance - 1:
                continue
            if next_pos is None or manhattan(nxt) < manhattan(next_pos):
                next_pos = nxt
        if next_pos is None:
            break
        path_edges.add(canonical_edge(cursor, next_pos))
        cursor = next_pos
    return path_edges


def choose_adaptive_wall_mode(base_distance: int, pawn: Pos, walls: Set[Edge], pawn_history: Optional[List[Pos]] = None) -> str:
    history = pawn_history or []
    insights, _, _, best = get_pawn_move_insights(pawn, walls, history)
    loop_risk = insights[best].loop_risk if best is not None and best in insights else 0.0
    if base_distance <= 7 and loop_risk < 0.55:
        return "aggressive"
    return "robust"


def evaluate_adaptive_wall_candidate(pawn: Pos, walls: Set[Edge], edge: Edge, base_distance: int, shortest_path_edges: Set[Edge], mode: str) -> Optional[Tuple[float, int, int, int, int]]:
    if edge in walls:
        return None
    test_set = set(walls)
    test_set.add(edge)
    if not has_path(pawn, test_set):
        return None

    distance_after_wall = shortest_path_length(pawn, test_set)
    if distance_after_wall >= INF:
        return None

    mobility_after_wall = len(valid_pawn_moves(pawn, test_set))
    distance_gain = distance_after_wall - base_distance
    blocks_canonical_path = 1 if edge in shortest_path_edges else 0

    low_mobility_risk = 1.0 if mobility_after_wall <= 1 else (0.45 if mobility_after_wall == 2 else 0.0)
    stagnant_pocket_risk = 0.6 if mobility_after_wall <= 2 and distance_gain <= 0 else 0.0
    deadlock_risk = min(1.0, low_mobility_risk + stagnant_pocket_risk)
    if deadlock_risk >= 0.95:
        return None

    aggressive_utility = (
        distance_after_wall * 8
        + distance_gain * 5
        + blocks_canonical_path * 4
        - mobility_after_wall * 1.2
        - deadlock_risk * 24
    )
    robust_utility = (
        distance_after_wall * 6
        + distance_gain * 2.8
        + blocks_canonical_path * 2.2
        + mobility_after_wall * 0.7
        - deadlock_risk * 30
    )
    utility = aggressive_utility if mode == "aggressive" else robust_utility
    return (utility, distance_after_wall, distance_gain, blocks_canonical_path, -mobility_after_wall)


def choose_adaptive_wall_action(pawn: Pos, walls: Set[Edge], pawn_history: Optional[List[Pos]] = None) -> Optional[Edge]:
    base_distance = shortest_path_length(pawn, walls)
    shortest_path_edges = build_canonical_shortest_path_edges(pawn, walls)
    mode = choose_adaptive_wall_mode(base_distance, pawn, walls, pawn_history)

    best_edge: Optional[Edge] = None
    best_tuple: Optional[Tuple[float, int, int, int, int]] = None
    for edge in ALL_EDGES:
        candidate_tuple = evaluate_adaptive_wall_candidate(pawn, walls, edge, base_distance, shortest_path_edges, mode)
        if candidate_tuple is None:
            continue
        if best_tuple is None or compare_tuple(candidate_tuple, best_tuple) > 0:
            best_tuple = candidate_tuple
            best_edge = edge
    return best_edge


def run_game(policy: StateBasedWallPolicy, max_turns: int = MAX_TURNS, capture_trajectory: bool = False) -> EvalResult:
    pawn = START
    walls: Set[Edge] = set()
    score = 0
    fallback_count = 0
    pawn_history: List[Pos] = []
    trajectory: List[Tuple[Pos, Set[Edge], Optional[Edge]]] = []

    while pawn != GOAL and score < max_turns:
        pre_walls = set(walls)
        pre_pawn = pawn
        action, source = policy.choose_action(pawn, walls)
        if source == "fallback":
            fallback_count += 1
        if action is not None and action not in walls and has_path(pawn, walls | {action}):
            walls.add(action)
        if capture_trajectory:
            trajectory.append((pre_pawn, pre_walls, action))

        move = choose_optimal_pawn_move(pawn, walls, pawn_history)
        if move is None:
            break
        pawn_history.append(move)
        pawn = move
        score += 1

    return EvalResult(
        score=score,
        reached_goal=pawn == GOAL,
        wall_count=len(walls),
        fallback_count=fallback_count,
        trajectory=trajectory,
    )


def extract_turn_actions_from_replay(path: str) -> Dict[str, Optional[Edge]]:
    with open(path, "r", encoding="utf-8") as f:
        entries = [json.loads(line) for line in f if line.strip()]

    current_walls: Set[Edge] = set()
    turn_start_pawn = START
    turn_start_walls: Set[Edge] = set(current_walls)
    pending_action: Optional[Edge] = None
    mapping: Dict[str, Optional[Edge]] = {}

    for entry in entries:
        actor = entry.get("actor")
        action = entry.get("action")

        if actor == "Wall-Setter" and action == "place_wall":
            edge_key = entry["details"]["edgeKey"]
            edge = edge_from_key(edge_key)
            pending_action = edge
            current_walls.add(edge)
            continue

        if actor == "Pawn-Pusher" and action == "move_pawn":
            mapping[state_hash(turn_start_pawn, turn_start_walls)] = pending_action
            pawn_obj = entry["pawn"]
            turn_start_pawn = (int(pawn_obj["x"]), int(pawn_obj["y"]))
            turn_start_walls = set(current_walls)
            pending_action = None

    return mapping


def optimize_policy(initial_map: Dict[str, Optional[Edge]], iterations: int = 180, seed: int = 42) -> Tuple[Dict[str, Optional[Edge]], Dict[str, object]]:
    rng = random.Random(seed)
    working_map = dict(initial_map)
    policy = StateBasedWallPolicy(working_map, {e for e in initial_map.values() if e is not None})
    best_eval = run_game(policy, capture_trajectory=True)
    accepted = 0

    for _ in range(iterations):
        if not best_eval.trajectory:
            break
        pawn, walls, current_action = rng.choice(best_eval.trajectory)
        key = state_hash(pawn, walls)

        base_dist = shortest_path_length(pawn, walls)
        shortest_path_edges = build_canonical_shortest_path_edges(pawn, walls)
        mode = choose_adaptive_wall_mode(base_dist, pawn, walls)
        candidates: List[Optional[Edge]] = [None]
        scored_edges: List[Tuple[Tuple[float, int, int, int, int], Edge]] = []
        for edge in ALL_EDGES:
            c_tuple = evaluate_adaptive_wall_candidate(pawn, walls, edge, base_dist, shortest_path_edges, mode)
            if c_tuple is None:
                continue
            scored_edges.append((c_tuple, edge))
        scored_edges.sort(key=lambda item: item[0], reverse=True)
        for _, edge in scored_edges[:8]:
            candidates.append(edge)
        if current_action is not None:
            candidates.append(current_action)
        rng.shuffle(candidates)

        trial_action = candidates[0]
        trial_map = dict(working_map)
        trial_map[key] = trial_action
        trial_policy = StateBasedWallPolicy(trial_map, {e for e in trial_map.values() if e is not None})
        trial_eval = run_game(trial_policy, capture_trajectory=False)

        if trial_eval.score >= best_eval.score:
            working_map = trial_map
            policy = trial_policy
            best_eval = run_game(policy, capture_trajectory=True)
            accepted += 1

    report = {
        "best_score": best_eval.score,
        "reached_goal": best_eval.reached_goal,
        "wall_count": best_eval.wall_count,
        "fallback_count": best_eval.fallback_count,
        "accepted_mutations": accepted,
        "iterations": iterations,
    }
    return working_map, report


def evaluate(policy: StateBasedWallPolicy, eval_runs: int = 3) -> Dict[str, object]:
    deterministic = run_game(policy, capture_trajectory=False)
    scores = []
    for _ in range(eval_runs):
        result = run_game(policy, capture_trajectory=False)
        scores.append(result.score)
    return {
        "deterministic_adaptive_pawn": {
            "score": deterministic.score,
            "reached_goal": deterministic.reached_goal,
            "wall_count": deterministic.wall_count,
            "fallback_count": deterministic.fallback_count,
        },
        f"repeatability_{eval_runs}_runs": {
            "min_score": min(scores),
            "max_score": max(scores),
            "avg_score": round(mean(scores), 3),
        },
    }


def serialize_exact_policy(state_action_map: Dict[str, Optional[Edge]]) -> List[Dict[str, object]]:
    rows = []
    for key, action in sorted(state_action_map.items()):
        rows.append(
            {
                "stateHash": key,
                "action": None if action is None else edge_to_key(action),
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Build replay-seeded state policy for wall-pawn game.")
    parser.add_argument("--iterations", type=int, default=8, help="Local-search iterations for policy mutation.")
    parser.add_argument("--eval-runs", type=int, default=3, help="Number of deterministic repeat runs for report.")
    parser.add_argument("--seed", type=int, default=7, help="Random seed for optimization.")
    args = parser.parse_args()

    source_replay_path = "log/wall-pawn-game-log-replay.jsonl"
    target_path = "log/wall-pawn-state-policy.json"

    seed_map = extract_turn_actions_from_replay(source_replay_path)
    optimized_map, optimization_report = optimize_policy(seed_map, iterations=args.iterations, seed=args.seed)

    template_edges = {a for a in optimized_map.values() if a is not None}
    policy = StateBasedWallPolicy(optimized_map, template_edges)
    eval_report = evaluate(policy, eval_runs=args.eval_runs)

    payload = {
        "sourceReplay": source_replay_path,
        "strategyType": "state_based_with_replay_seed_and_local_search",
        "description": {
            "exact_state_rule": "If full state hash matches replay/optimized map, use stored action.",
            "fallback_rule": "Otherwise apply adaptive wall chooser aligned to current app.js utility and deadlock penalties.",
            "optimizer": "Randomized local search mutating state actions from replay seed.",
        },
        "templateWalls": sorted(edge_to_key(e) for e in template_edges),
        "exactStatePolicy": serialize_exact_policy(optimized_map),
        "optimization": optimization_report,
        "evaluation": eval_report,
    }

    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote {target_path}")
    print(json.dumps({"optimization": optimization_report, "evaluation": eval_report}, indent=2))


if __name__ == "__main__":
    main()
