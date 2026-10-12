/**
 * Pace of a full nation game: how fast the map fills up and how fast a leader
 * snowballs.
 *
 * Spawns every nation from the world map manifest at Medium difficulty plus
 * 400 tribes (the single-player defaults' bot count) with the real production
 * EngineConfig, and lets the real NationExecutions and TribeExecutions play.
 * Each game minute (600 ticks) it samples how much of the land is owned, the
 * leader's and top three's share of it, and how many nations and tribes are
 * still alive. The table is pinned in a snapshot, so a change to the attack
 * formula or to the pace multipliers (EngineConfig.attackLossMultiplier and
 * friends) shows up as a diff of how the whole game unfolds.
 *
 * PACE_SWEEP=1 also runs the same game once per entry of SWEEP below and
 * prints a summary of each, for tuning the multipliers:
 *   PACE_SWEEP=1 npx vitest tests/NationGamePace.test.ts --run -t sweep \
 *     --disableConsoleIntercept
 *
 * All randomness is PseudoRandom seeded from the fixed game ID and nation
 * names, so runs are deterministic.
 */
import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { RecomputeRailClusterExecution } from "@openfront/engine/execution/RecomputeRailClusterExecution";
import { TribeSpawner } from "@openfront/engine/execution/TribeSpawner";
import { Game } from "@openfront/engine/game/Game";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "./util/Setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GAME_ID = "nation-game-pace";
const TICKS_PER_MINUTE = 600; // 10 ticks per second
const MINUTES = 20;
const TRIBES = 400;

interface PaceMultipliers {
  attackLoss: number;
  attackTime: number;
  expansionLoss: number;
  expansionTime: number;
}

// Variants PACE_SWEEP=1 compares. The first is upstream OpenFront.
const SWEEP: PaceMultipliers[] = [
  { attackLoss: 1, attackTime: 1, expansionLoss: 1, expansionTime: 1 },
  {
    attackLoss: 1.25,
    attackTime: 1.25,
    expansionLoss: 1.25,
    expansionTime: 1.1,
  },
  { attackLoss: 1.5, attackTime: 1.5, expansionLoss: 1.5, expansionTime: 1.25 },
  { attackLoss: 2, attackTime: 2, expansionLoss: 2, expansionTime: 1.5 },
];

function configWith(m: PaceMultipliers): typeof EngineConfig {
  return class extends EngineConfig {
    attackLossMultiplier(): number {
      return m.attackLoss;
    }
    attackTimeMultiplier(): number {
      return m.attackTime;
    }
    expansionLossMultiplier(): number {
      return m.expansionLoss;
    }
    expansionTimeMultiplier(): number {
      return m.expansionTime;
    }
  };
}

function loadWorldNations(): Nation[] {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "testdata/maps/world/manifest.json"),
      "utf8",
    ),
  ) as { nations: { coordinates: [number, number]; name: string }[] };
  // The nation name doubles as the player ID so every NationExecution seeds
  // the same RNG stream on every run.
  return manifest.nations.map(
    (n) =>
      new Nation(
        new Cell(n.coordinates[0], n.coordinates[1]),
        new PlayerInfo(n.name, PlayerType.Nation, null, n.name),
      ),
  );
}

/** Percent with one decimal. */
function pct(part: number, whole: number): number {
  return Math.round((1000 * part) / whole) / 10;
}

interface MinuteRow {
  minute: number;
  /** Share of all land owned by anyone, in percent. */
  claimedPct: number;
  /** The largest player's share of all land, in percent. */
  leaderPct: number;
  /** The three largest players' combined share of all land, in percent. */
  top3Pct: number;
  nationsAlive: number;
  tribesAlive: number;
}

function sample(game: Game, minute: number): MinuteRow {
  const land = game.numLandTiles();
  const alive = game.players();
  const sizes = alive.map((p) => p.numTilesOwned()).sort((a, b) => b - a);
  const claimed = sizes.reduce((a, b) => a + b, 0);
  return {
    minute,
    claimedPct: pct(claimed, land),
    leaderPct: pct(sizes[0] ?? 0, land),
    top3Pct: pct(
      sizes.slice(0, 3).reduce((a, b) => a + b, 0),
      land,
    ),
    nationsAlive: alive.filter((p) => p.type() === PlayerType.Nation).length,
    tribesAlive: alive.filter((p) => p.type() === PlayerType.Bot).length,
  };
}

async function runPaceGame(
  ConfigClass: typeof EngineConfig,
  minutes: number,
): Promise<MinuteRow[]> {
  const nations = loadWorldNations();
  const game = await setup(
    "world",
    { difficulty: Difficulty.Medium },
    [],
    undefined,
    ConfigClass,
    false, // keep the spawn phase open so nations and tribes can place
    nations,
  );
  for (const nation of nations) {
    game.addExecution(new NationExecution(GAME_ID, nation));
  }
  game.addExecution(
    ...new TribeSpawner(
      game,
      GAME_ID,
      nations.map((n) => n.spawnCell).filter((c): c is Cell => c !== undefined),
    ).spawnTribes(TRIBES),
  );
  // Mirror GameRunner.init: trains only run when rail clusters are recomputed.
  game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));

  // players() only returns alive (spawned) players, so poll allPlayers().
  for (
    let i = 0;
    i < 100 &&
    game
      .allPlayers()
      .some((p) => p.type() === PlayerType.Nation && !p.hasSpawned());
    i++
  ) {
    game.executeNextTick();
  }
  game.endSpawnPhase();

  const rows: MinuteRow[] = [];
  for (let minute = 1; minute <= minutes; minute++) {
    for (let t = 0; t < TICKS_PER_MINUTE; t++) {
      game.executeNextTick();
    }
    rows.push(sample(game, minute));
  }
  return rows;
}

/** First minute at which `pick(row)` reaches `threshold`, or null. */
function firstMinute(
  rows: MinuteRow[],
  pick: (r: MinuteRow) => number,
  threshold: number,
): number | null {
  return rows.find((r) => pick(r) >= threshold)?.minute ?? null;
}

function summarize(rows: MinuteRow[]) {
  const at = (m: number) => rows[Math.min(m, rows.length) - 1];
  return {
    leader10PctAtMin: firstMinute(rows, (r) => r.leaderPct, 10),
    leader20PctAtMin: firstMinute(rows, (r) => r.leaderPct, 20),
    leader30PctAtMin: firstMinute(rows, (r) => r.leaderPct, 30),
    leaderPctAt5Min: at(5).leaderPct,
    leaderPctAt10Min: at(10).leaderPct,
    leaderPctAt20Min: at(20).leaderPct,
    nationsAliveAt10Min: at(10).nationsAlive,
    nationsAliveAt20Min: at(20).nationsAlive,
    tribesAliveAt5Min: at(5).tribesAlive,
    tribesAliveAt10Min: at(10).tribesAlive,
  };
}

describe("nation game pace", () => {
  test("world map, medium nations and 400 tribes, 20 minutes", async () => {
    const rows = await runPaceGame(EngineConfig, MINUTES);
    expect({ summary: summarize(rows), perMinute: rows }).toMatchSnapshot();
  }, 900_000);

  test.runIf(process.env.PACE_SWEEP)(
    "sweep pace multipliers",
    async () => {
      for (const m of SWEEP) {
        const rows = await runPaceGame(configWith(m), MINUTES);
        console.log(
          `PACE ${JSON.stringify(m)}\n` +
            `${JSON.stringify(summarize(rows))}\n` +
            `leaderPct by minute: ${rows.map((r) => r.leaderPct).join(" ")}\n` +
            `claimedPct by minute: ${rows.map((r) => r.claimedPct).join(" ")}`,
        );
      }
    },
    SWEEP.length * 900_000,
  );
});
