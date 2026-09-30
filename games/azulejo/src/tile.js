/**
 * Tile model.
 *
 * A tile carries four edge colours (N, E, S, W) plus a kind that drives
 * decoration. Rotation is the core verb of the game, so it is modelled as an
 * immutable value: `rotated(tile, n)` returns a new tile, never mutating.
 */


export const EDGE = { N: 0, E: 1, S: 2, W: 3 };

/** Wild edge: matches any colour, but contributes nothing to a wall. */
export const NEUTRAL = 5;

/** Clockwise rotation: the value at edge `e` ends up at edge `CW[e]`. */
const CW = [EDGE.W, EDGE.N, EDGE.E, EDGE.S];

export function makeTile(edges, kind = 'pattern', variant = 0) {
  return { id: 0, edges: edges.slice(), kind, variant };
}

export function rotated(tile, n) {
  n = ((n % 4) + 4) % 4;
  if (n === 0) return tile;
  const out = { edges: [0, 0, 0, 0], kind: tile.kind, variant: (tile.variant + n) % 4, id: tile.id };
  for (let e = 0; e < 4; e++) {
    let dest = e;
    for (let k = 0; k < n; k++) dest = CW[dest];
    out.edges[dest] = tile.edges[e];
  }
  return out;
}

/** All distinct orientations of a tile (most are symmetric, so often 1-2). */
export function orientations(tile) {
  const seen = new Set();
  const out = [];
  for (let n = 0; n < 4; n++) {
    const r = rotated(tile, n);
    const k = r.edges.join('');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** True when `tile` can legally sit at (r,c): every shared edge agrees. */
export function matchesNeighbours(edges, neighbours) {
  for (const nb of neighbours) {
    if (nb.edge === null) continue;
    const mine = edges[nb.edge];
    const theirs = nb.value;
    if (mine === NEUTRAL || theirs === NEUTRAL) continue;
    if (mine !== theirs) return false;
  }
  return true;
}

/**
 * The 100-tile pool.
 *
 * Not a transcription of the physical Azulejo set (which cannot be reproduced
 * from memory without inventing tiles). Instead this generates a deterministic
 * pool with the structural properties the rules actually need:
 *   - a fixed colour budget, so walls complete at a predictable rate;
 *   - a healthy share of wild edges, so late-game placement stays flexible;
 *   - a handful of near-solid tiles, so passing without committing is possible.
 *
 * Pass an `rng` to make the pool reproducible. The default uses Math.random,
 * which is right for a real game (fresh pool each session) and wrong for a test
 * (nothing to compare against).
 */
export function buildTileSet(total = 100, rng = Math.random) {
  // Local integer helper: the pool must be reproducible from a seed, otherwise
  // two runs of the same seed still differ and no benchmark is comparable.
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  const tiles = [];
  let id = 0;

  // Colour budget, normalised to `total`. Higher = easier colour to complete.
  const weights = [0.28, 0.22, 0.19, 0.17, 0.14];
  const budget = weights.map((w) => Math.round(total * w));

  for (let color = 0; color < 5; color++) {
    let remaining = budget[color];
    while (remaining > 0) {
      // How many of this tile's edges carry the wall colour.
      const slots = Math.min(4, remaining);
      const edges = new Array(4).fill(NEUTRAL);
      for (let i = 0; i < slots; i++) {
        edges[ri(0, 3)] = color;
      }
      remaining -= slots;

      const wild = edges.filter((e) => e === NEUTRAL).length;
      const kind = slots === 1 ? 'solid' : wild === 0 ? 'corner' : 'pattern';
      tiles.push({ id: id++, edges, kind, variant: ri(0, 3) });
    }
  }

  // Top up or trim to hit the requested count exactly.
  while (tiles.length < total) {
    const color = ri(0, 4);
    const edges = new Array(4).fill(NEUTRAL);
    edges[ri(0, 3)] = color;
    tiles.push({ id: id++, edges, kind: 'solid', variant: ri(0, 3) });
  }
  tiles.length = total;

  return tiles;
}
