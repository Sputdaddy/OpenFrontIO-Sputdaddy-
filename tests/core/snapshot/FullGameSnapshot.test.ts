import { GameMode } from "@openfront/engine-api/game/GameTypes";
import { GameConfig, GameStartInfo } from "@openfront/engine-api/Schemas";
import { Game } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import { EXECUTION_SNAPSHOT_TYPES } from "@openfront/engine/snapshot/ExecutionRegistry";
import { decodeSnapshotValue } from "@openfront/engine/snapshot/SnapshotCodec";
import {
  createScriptedRunner,
  restoreScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "../../util/ScriptedGame";
import { diffSnapshots } from "../../util/Snapshot";

/**
 * The oracle from the design doc: a game played straight through and the
 * same game snapshotted and restored along the way must agree on every
 * tick's hash and, at every checkpoint, on the snapshot bytes themselves
 * (the hash only covers troops, tiles and unit positions).
 *
 * Each game also records which execution types its snapshots hold, and the
 * first snapshot holding each type is restored, so every type survives a
 * restore in a full game.
 */

const MAP = "world";
const TICKS = 1500;
const CHECK_EVERY = 100;
// Execution types are sampled more often than checkpoints are taken:
// missiles and shells live for a few dozen ticks, so most of them fall
// between checkpoints.
const SAMPLE_EVERY = 10;
// Restore at every tick of this window, chaining each restore into the next.
const WINDOW_START = 700;
const WINDOW_TICKS = 40;
const TEST_TIMEOUT = 300_000;

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

function execTypesIn(bytes: Uint8Array): Set<string> {
  const root = decodeSnapshotValue(bytes) as { execs: { t: string }[] };
  return new Set(root.execs.map((e) => e.t));
}

interface Reference {
  hashes: number[];
  checkpoints: Map<number, Uint8Array>;
  final: Uint8Array;
  winnerTick: number | null;
  execTypes: Set<string>;
  // The first sampled snapshot holding each execution type, by tick.
  firstHolding: Map<number, { types: string[]; bytes: Uint8Array }>;
}

async function playReference(start: GameStartInfo): Promise<Reference> {
  const runner = await createScriptedRunner(MAP, start);
  const hashes: number[] = [];
  const checkpoints = new Map<number, Uint8Array>();
  const execTypes = new Set<string>();
  const firstHolding = new Map<
    number,
    { types: string[]; bytes: Uint8Array }
  >();
  let winnerTick: number | null = null;
  while (runner.game.ticks() < TICKS) {
    const tick = runner.game.ticks();
    if (
      tick % SAMPLE_EVERY === 0 ||
      (tick >= WINDOW_START && tick < WINDOW_START + WINDOW_TICKS)
    ) {
      const bytes = runner.snapshot();
      if (tick % CHECK_EVERY === 0) checkpoints.set(tick, bytes);
      const types = [...execTypesIn(bytes)].filter((t) => !execTypes.has(t));
      if (types.length > 0) {
        for (const t of types) execTypes.add(t);
        firstHolding.set(tick, { types, bytes });
      }
    }
    stepScripted(runner);
    hashes[runner.game.ticks()] = hash(runner.game);
    if (winnerTick === null && runner.game.getWinner() !== null) {
      winnerTick = runner.game.ticks();
    }
  }
  return {
    hashes,
    checkpoints,
    final: runner.snapshot(),
    winnerTick,
    execTypes,
    firstHolding,
  };
}

function expectOnTrack(runner: GameRunner, ref: Reference): void {
  const tick = runner.game.ticks();
  if (hash(runner.game) !== ref.hashes[tick]) {
    throw new Error(`hash diverged at tick ${tick}`);
  }
  const checkpoint = ref.checkpoints.get(tick);
  if (checkpoint !== undefined) {
    const diffs = diffSnapshots(runner.snapshot(), checkpoint);
    if (diffs.length > 0) {
      throw new Error(`state diverged at tick ${tick}:\n${diffs.join("\n")}`);
    }
  }
}

// The execution types held by any of the games' snapshots.
const execTypesSeen = new Set<string>();

const VARIANTS: [string, Partial<GameConfig>][] = [
  ["free for all", {}],
  // Water nukes rewrite terrain and the water graph mid-game.
  ["water nukes", { waterNukes: true }],
  ["teams", { gameMode: GameMode.Team, playerTeams: 2 }],
];

describe.each(VARIANTS)("full game snapshots: %s", (_, overrides) => {
  const start = scriptedGameStart(overrides);
  let reference: Reference;

  beforeAll(async () => {
    reference = await playReference(start);
    for (const t of reference.execTypes) execTypesSeen.add(t);
  }, TEST_TIMEOUT);
  test(
    "snapshot -> restore -> snapshot is byte-identical at every checkpoint",
    async () => {
      for (const [tick, bytes] of reference.checkpoints) {
        const restored = await restoreScriptedRunner(MAP, start, bytes);
        expect(restored.game.ticks()).toBe(tick);
        const diffs = diffSnapshots(restored.snapshot(), bytes);
        expect(diffs, `tick ${tick}`).toEqual([]);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "restoring every 100 ticks continues exactly like the straight run",
    async () => {
      let runner = await restoreScriptedRunner(
        MAP,
        start,
        reference.checkpoints.get(0)!,
      );
      let winnerTick: number | null = null;
      while (runner.game.ticks() < TICKS) {
        stepScripted(runner);
        expectOnTrack(runner, reference);
        if (winnerTick === null && runner.game.getWinner() !== null) {
          winnerTick = runner.game.ticks();
        }
        if (runner.game.ticks() % CHECK_EVERY === 0) {
          runner = await restoreScriptedRunner(MAP, start, runner.snapshot());
        }
      }
      expect(diffSnapshots(runner.snapshot(), reference.final)).toEqual([]);
      expect(winnerTick).toBe(reference.winnerTick);
    },
    TEST_TIMEOUT,
  );

  test(
    "restoring at every tick of a mid-game window stays on track",
    async () => {
      const from = Math.floor(WINDOW_START / CHECK_EVERY) * CHECK_EVERY;
      let runner = await restoreScriptedRunner(
        MAP,
        start,
        reference.checkpoints.get(from)!,
      );
      while (runner.game.ticks() < WINDOW_START) stepScripted(runner);
      while (runner.game.ticks() < WINDOW_START + WINDOW_TICKS) {
        runner = await restoreScriptedRunner(MAP, start, runner.snapshot());
        stepScripted(runner);
        expectOnTrack(runner, reference);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the first snapshot holding each execution type restores byte-identically",
    async () => {
      for (const [tick, { types, bytes }] of reference.firstHolding) {
        const restored = await restoreScriptedRunner(MAP, start, bytes);
        expect(restored.game.ticks()).toBe(tick);
        const diffs = diffSnapshots(restored.snapshot(), bytes);
        expect(diffs, `tick ${tick} (${types.join(", ")})`).toEqual([]);
      }
    },
    TEST_TIMEOUT,
  );
});

// Checked on all the games together: with this fork's slower conquest the
// free-for-all game launches no SAM missiles or shells before TICKS, while
// the other two do.
test(
  "the scripted games exercised every execution type",
  () => {
    // Runs during the spawn phase and finishes inside init, so it is never
    // alive at a tick boundary. BasicExecutions.test.ts covers it directly.
    const neverStored = new Set(["Pause"]);
    const missing = EXECUTION_SNAPSHOT_TYPES.map((t) => t.name).filter(
      (name) => !execTypesSeen.has(name) && !neverStored.has(name),
    );
    expect(missing).toEqual([]);
  },
  TEST_TIMEOUT,
);
