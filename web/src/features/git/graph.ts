/**
 * Lane assignment for a commit graph.
 *
 * Commits arrive newest first (children before parents). We track which commit each lane is waiting for; a
 * commit takes the lane that was waiting for it (or a fresh one, for a branch tip), its first parent inherits
 * that lane, and each further parent gets a lane of its own. Each row records just enough to draw itself: the
 * lines passing straight through, the line arriving from above, and the lines leaving to its parents.
 */
export interface GraphEdge {
  /** Lane at the node (always the node's own column). */
  from: number;
  /** Lane the line reaches at the bottom of the row. */
  to: number;
}

export interface GraphRow {
  sha: string;
  col: number;
  /** A line arrives at the node from the row above. False for a branch tip. */
  fromAbove: boolean;
  /** Lines that do not touch the node: straight through, or bending toward another lane. */
  passing: Array<{ lane: number; to: number }>;
  /** Lines from the node to its parents' lanes. */
  edges: GraphEdge[];
  merge: boolean;
}

export interface Graph {
  rows: GraphRow[];
  maxLanes: number;
}

export function computeGraph(commits: Array<{ sha: string; parents: string[] }>): Graph {
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];
  let maxLanes = 1;

  const freeLane = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    const fromAbove = col !== -1;
    if (col === -1) col = freeLane();

    // Lines that wait for other commits go straight through this row.
    const passing: GraphRow["passing"] = [];
    lanes.forEach((waiting, lane) => {
      if (waiting !== null && lane !== col) passing.push({ lane, to: lane });
    });

    const next = lanes.slice();
    next[col] = null;
    const edges: GraphEdge[] = [];

    c.parents.forEach((p, i) => {
      const existing = next.indexOf(p);
      if (i === 0) {
        if (existing === -1) {
          next[col] = p;
          edges.push({ from: col, to: col });
        } else if (existing > col) {
          // The parent is already waited on further right: pull that line left into this lane, so the trunk stays put.
          const pass = passing.find((x) => x.lane === existing);
          if (pass) pass.to = col;
          next[existing] = null;
          next[col] = p;
          edges.push({ from: col, to: col });
        } else {
          edges.push({ from: col, to: existing });
        }
      } else if (existing !== -1) {
        edges.push({ from: col, to: existing });
      } else {
        // `freeLane` mutates `lanes`; keep `next` the same length.
        let k = next.indexOf(null);
        if (k === -1 || k === col) {
          next.push(null);
          k = next.length - 1;
        }
        next[k] = p;
        edges.push({ from: col, to: k });
      }
    });

    while (next.length && next[next.length - 1] === null) next.pop();
    lanes.length = 0;
    lanes.push(...next);

    const used = [col + 1, ...passing.map((p) => Math.max(p.lane, p.to) + 1), ...edges.map((e) => e.to + 1)];
    maxLanes = Math.max(maxLanes, ...used);
    rows.push({ sha: c.sha, col, fromAbove, passing, edges, merge: c.parents.length > 1 });
  }
  return { rows, maxLanes };
}

export const LANE_COLORS = ["var(--accent)", "var(--violet)", "var(--amber)", "var(--green)", "var(--blue)", "var(--red)"];
export const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length];
