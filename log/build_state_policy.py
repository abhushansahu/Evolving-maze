import hashlib
import json
import random
from collections import deque
from dataclasses import dataclass
from statistics import mean
from typing import Dict, List, Optional, Set, Tuple


GRID_SIZE = 10
START = (1, 1)
GOAL = (10, 10)

Edge = Tuple[Tuple[int, int], Tuple[int, int]]


def canonical_edge(a: Tuple[int, int], b: Tuple[int, int]) -> Edge:
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


def neighbors(pos: Tuple[int, int]) -> List[Tuple[int, int]]:
    x, y = pos
    candidates = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return [(nx, ny) for nx, ny in candidates if 1 <= nx <= GRID_SIZE and 1 <= ny <= GRID_SIZE]


def shortest_distance_map(goal: Tuple[int, int], walls: Set[Edge]) -> Dict[Tuple[int, int], int]:
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


def shortest_path_length(start: Tuple[int, int], walls: Set[Edge]) -> int:
    return shortest_distance_map(GOAL, walls).get(start, 10**9)


def has_path(start: Tuple[int, int], walls: Set[Edge]) -> bool:
    return shortest_path_length(start, walls) < 10**9


def valid_pawn_moves(pos: Tuple[int, int], walls: Set[Edge]) -> List[Tuple[int, int]]:
    return [nxt for nxt in neighbors(pos) if canonical_edge(pos, nxt) not in walls]


def optimal_pawn_moves(
    pos: Tuple[int, int],
    walls: Set[Edge],
    tie_mode: str = "app",
    rng: Optional[random.Random] = None,
) -> Tuple[List[Tuple[int, int]], Tuple[int, int]]:
    valid = valid_pawn_moves(pos, walls)
    dist = shortest_distance_map(GOAL, walls)
    best_dist = min(dist.get(v, 10**9) for v in valid)
    best = [v for v in valid if dist.get(v, 10**9) == best_dist]

    if tie_mode == "app":
        # Match app.js behavior: Manhattan tie-break toward goal, then keep first.
        best_manhattan = min(abs(x - GOAL[0]) + abs(y - GOAL[1]) for x, y in best)
        best = [v for v in best if abs(v[0] - GOAL[0]) + abs(v[1] - GOAL[1]) == best_manhattan]
        chosen = best[0]
    elif tie_mode == "random":
        assert rng is not None
        chosen = rng.choice(best)
    else:
        raise ValueError(f"Unknown tie_mode: {tie_mode}")

    return best, chosen


def state_hash(pawn: Tuple[int, int], walls: Set[Edge]) -> str:
    wall_keys = sorted(edge_to_key(edge) for edge in walls)
    payload = json.dumps({"pawn": pawn, "walls": wall_keys}, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PolicyDecision:
    action: Optional[Edge]
    source: str  # "exact" or "fallback"


class StateBasedWallPolicy:
    def __init__(self, state_action_map: Dict[str, Optional[Edge]], template_edges: Set[Edge]):
        self.state_action_map = state_action_map
        self.template_edges = template_edges
        self.fallback_cache: Dict[str, Optional[Edge]] = {}

    def choose_action(self, pawn: Tuple[int, int], walls: Set[Edge]) -> PolicyDecision:
        key = state_hash(pawn, walls)
        if key in self.state_action_map:
            action = self.state_action_map[key]
            if action is None:
                return PolicyDecision(action=None, source="exact")
            if action not in walls and has_path(pawn, walls | {action}):
                return PolicyDecision(action=action, source="exact")

        if key in self.fallback_cache:
            return PolicyDecision(action=self.fallback_cache[key], source="fallback")

        # Fallback: choose legal wall that best delays and reduces tie branching.
        base_dist = shortest_path_length(pawn, walls)
        current_best_moves, _ = optimal_pawn_moves(pawn, walls, tie_mode="app")
        best_score = (base_dist, -len(current_best_moves), -1, "pass")
        best_action = None

        # Keep fallback candidate set focused and reproducible:
        # 1) unplaced template edges
        # 2) edges adjacent to pawn and immediate optimal-move frontier
        candidate_edges: Set[Edge] = {e for e in self.template_edges if e not in walls}
        frontier = {pawn}
        app_best_moves, _ = optimal_pawn_moves(pawn, walls, tie_mode="app")
        frontier.update(app_best_moves)
        for node in list(frontier):
            for nxt in neighbors(node):
                edge = canonical_edge(node, nxt)
                if edge not in walls:
                    candidate_edges.add(edge)

        for edge in sorted(candidate_edges, key=edge_to_key):
            if edge in walls:
                continue
            candidate_walls = set(walls)
            candidate_walls.add(edge)
            if not has_path(pawn, candidate_walls):
                continue

            dist = shortest_path_length(pawn, candidate_walls)
            best_moves, _ = optimal_pawn_moves(pawn, candidate_walls, tie_mode="app")
            template_bonus = 1 if edge in self.template_edges else 0

            score = (dist, -len(best_moves), template_bonus, edge_to_key(edge))
            if score > best_score:
                best_score = score
                best_action = edge

        self.fallback_cache[key] = best_action
        return PolicyDecision(action=best_action, source="fallback")


def load_action_sequence(path: str) -> List[Optional[Edge]]:
    data = json.load(open(path, "r", encoding="utf-8"))
    actions = []
    for item in data["actions"]:
        actions.append(None if item is None else edge_from_key(item))
    return actions


def build_exact_state_map(actions: List[Optional[Edge]]) -> Dict[str, Optional[Edge]]:
    pawn = START
    walls: Set[Edge] = set()
    mapping: Dict[str, Optional[Edge]] = {}

    for action in actions:
        if pawn == GOAL:
            break
        mapping[state_hash(pawn, walls)] = action

        if action is not None and action not in walls and has_path(pawn, walls | {action}):
            walls.add(action)

        _, chosen = optimal_pawn_moves(pawn, walls, tie_mode="app")
        pawn = chosen

    return mapping


def run_game(
    policy: StateBasedWallPolicy,
    tie_mode: str,
    seed: int = 0,
    max_turns: int = 260,
) -> Dict[str, object]:
    pawn = START
    walls: Set[Edge] = set()
    score = 0
    fallback_count = 0
    rng = random.Random(seed)

    while pawn != GOAL and score < max_turns:
        decision = policy.choose_action(pawn, walls)
        if decision.source == "fallback":
            fallback_count += 1
        if decision.action is not None and decision.action not in walls and has_path(pawn, walls | {decision.action}):
            walls.add(decision.action)

        _, pawn = optimal_pawn_moves(
            pawn,
            walls,
            tie_mode=tie_mode,
            rng=rng if tie_mode == "random" else None,
        )
        score += 1

    return {
        "score": score,
        "reached_goal": pawn == GOAL,
        "wall_count": len(walls),
        "fallback_count": fallback_count,
    }


def evaluate(policy: StateBasedWallPolicy) -> Dict[str, object]:
    deterministic = run_game(policy, tie_mode="app")

    random_scores = []
    fallback_counts = []
    for seed in range(60):
        result = run_game(policy, tie_mode="random", seed=seed)
        random_scores.append(result["score"])
        fallback_counts.append(result["fallback_count"])

    return {
        "deterministic_app_tiebreak": deterministic,
        "random_tiebreak_60_runs": {
            "min_score": min(random_scores),
            "max_score": max(random_scores),
            "avg_score": round(mean(random_scores), 3),
            "avg_fallback_turns": round(mean(fallback_counts), 3),
        },
    }


def main() -> None:
    source_path = "log/wall-pawn-strategy-163.json"
    target_path = "log/wall-pawn-state-policy.json"

    actions = load_action_sequence(source_path)
    exact_map = build_exact_state_map(actions)
    template_edges = {a for a in actions if a is not None}
    policy = StateBasedWallPolicy(exact_map, template_edges)
    eval_report = evaluate(policy)

    serializable_map = []
    pawn = START
    walls: Set[Edge] = set()
    for action in actions:
        if pawn == GOAL:
            break
        serializable_map.append(
            {
                "stateHash": state_hash(pawn, walls),
                "pawn": {"x": pawn[0], "y": pawn[1]},
                "wallCount": len(walls),
                "action": None if action is None else edge_to_key(action),
            }
        )
        if action is not None and action not in walls and has_path(pawn, walls | {action}):
            walls.add(action)
        _, pawn = optimal_pawn_moves(pawn, walls, tie_mode="app")

    payload = {
        "sourceActionList": source_path,
        "strategyType": "state_based_with_fallback",
        "description": {
            "exact_state_rule": "If full state hash matches a known state from the 164-move run, play the stored action.",
            "fallback_rule": "Otherwise choose legal wall maximizing shortest-path length, then minimizing number of pawn-optimal tie moves, then preferring template walls.",
        },
        "templateWalls": sorted(edge_to_key(e) for e in template_edges),
        "exactStatePolicy": serializable_map,
        "evaluation": eval_report,
    }

    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote {target_path}")
    print(json.dumps(eval_report, indent=2))


if __name__ == "__main__":
    main()
