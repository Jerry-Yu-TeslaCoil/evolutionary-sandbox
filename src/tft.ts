import { addEntity, createWorld, listEntities, type Attrs, type World, type WorldRule } from "./world.ts";

type Move = "C" | "D";

interface Memory {
  t: number;
  lastOpp?: Move;
  prevOpp?: Move;
  lastMine?: Move;
  oppC: number;
  oppD: number;
  opp1?: Move;
  opp2?: Move;
  /** 上一拍外界合作、背叛的次数。同质化把所有人合成这一笔账。 */
  worldC: number;
  worldD: number;
  /** 同质化继续合作所需的最低合作占比。 */
  ratio: number;
  /** 爆发者记住的最近对手出法，最多 5 次。 */
  recent: string;
  /** 最近 5 次里被这个人背叛已达到 3 次，此后只对这个人背叛。 */
  burst: boolean;
}

export interface TftCategory {
  id: string;
  label: string;
  decide: (memory: Memory, roll: number) => Move;
}

export interface TftParams {
  /** 类别 id 或第几个类别（从 1 计）对应的初始人数。没写的类别是 0。 */
  counts: Record<string, number>;
  /** 每隔多少拍，在那一拍开始做一次繁衍淘汰。第 0 拍只对局。 */
  every: number;
  /** 每次淘汰的人数。从得分最低的人开始，同分按 id。 */
  eliminate: number;
  seed: number;
  /** 同质化的判断比例。上一拍合作占比达到它才合作。越低越乐观，越高越悲观。缺省 0.5。 */
  ratio?: number;
  /** 每个出牌决定被翻转的概率。缺省 0。 */
  flip?: number;
  /** 繁衍拍上最高分与最低分的差距不超过最高分的这个比例，就当作分数相同并提前结束。缺省 0。 */
  dead?: number;
}

const opening = (moves: readonly Move[], memory: Memory, after: (memory: Memory) => Move): Move => {
  if (memory.t < moves.length) return moves[memory.t] ?? "D";
  return after(memory);
};

/** 对方上一手背叛时仍合作的概率。对当前得分表，广泛用的是 1/3。 */
const forgivingChance = 1 / 3;

export const tftCategories: TftCategory[] = [
  { id: "tft", label: "以牙还牙", decide: (memory) => (memory.t === 0 || !memory.lastOpp ? "C" : memory.lastOpp) },
  {
    id: "softMajority",
    label: "温和多数派",
    decide: (memory) => (memory.oppC >= memory.oppD ? "C" : "D"),
  },
  {
    id: "titForTwoTats",
    label: "两次才还手",
    decide: (memory) => (memory.lastOpp === "D" && memory.prevOpp === "D" ? "D" : "C"),
  },
  { id: "alternator", label: "反复横跳", decide: (memory) => (memory.t % 2 === 0 ? "C" : "D") },
  {
    id: "pavlov",
    label: "赢守输变",
    decide: (memory) => {
      if (memory.t === 0 || !memory.lastMine || !memory.lastOpp) return "C";
      const got = payoff(memory.lastMine, memory.lastOpp);
      if (got >= 3) return memory.lastMine;
      return memory.lastMine === "C" ? "D" : "C";
    },
  },
  { id: "alwaysCooperate", label: "永远合作", decide: () => "C" },
  { id: "grudger", label: "记仇者", decide: (memory) => (memory.oppD > 0 ? "D" : "C") },
  {
    id: "detective",
    label: "侦探",
    decide: (memory) =>
      opening(["C", "D", "C", "C"], memory, (current) => (current.oppD > 0 ? current.lastOpp ?? "D" : "D")),
  },
  {
    id: "suspiciousTft",
    label: "多疑者",
    decide: (memory) => (memory.t === 0 || !memory.lastOpp ? "D" : memory.lastOpp),
  },
  { id: "random", label: "随机", decide: (_memory, roll) => (roll < 0.5 ? "C" : "D") },
  {
    id: "prober",
    label: "试探者",
    decide: (memory) =>
      opening(["D", "C", "C"], memory, (current) =>
        current.opp1 === "C" && current.opp2 === "C" ? "D" : current.lastOpp ?? "D",
      ),
  },
  {
    id: "hardMajority",
    label: "强硬多数派",
    decide: (memory) => (memory.oppC > memory.oppD ? "C" : "D"),
  },
  { id: "alwaysDefect", label: "永远背叛", decide: () => "D" },
  {
    id: "homogenized",
    label: "同质化",
    decide: (memory) => (seesCooperation(memory) ? "C" : "D"),
  },
  {
    id: "burster",
    label: "爆发者",
    decide: (memory) => (memory.burst || burstTriggered(memory.recent) ? "D" : "C"),
  },
  {
    id: "forgivingTft",
    label: "会原谅的以牙还牙",
    decide: (memory, roll) => {
      if (memory.t === 0 || !memory.lastOpp || memory.lastOpp === "C") return "C";
      return roll < forgivingChance ? "C" : "D";
    },
  },
];

const categoryById = new Map(tftCategories.map((category) => [category.id, category]));

export const defaultTftParams: TftParams = {
  counts: Object.fromEntries(tftCategories.map((category) => [category.id, 3])),
  every: 5,
  eliminate: 8,
  seed: 1,
  ratio: 0.5,
  flip: 0,
  dead: 0,
};

export interface CountMark {
  label: string;
  order: number;
  count: number;
  /** 人数最近一次变成 count 的拍。 */
  updatedAt: number;
}

export function rememberCounts(
  previous: readonly CountMark[],
  tick: number,
  current: readonly { order: number; label: string; count: number }[],
): CountMark[] {
  const marks = new Map(previous.map((row) => [row.order, { ...row }]));
  const seen = new Set<number>();
  for (const group of current) {
    seen.add(group.order);
    const mark = marks.get(group.order);
    if (!mark) {
      marks.set(group.order, { label: group.label, order: group.order, count: group.count, updatedAt: tick });
      continue;
    }
    if (mark.count !== group.count) {
      mark.count = group.count;
      mark.updatedAt = tick;
      mark.label = group.label;
    }
  }
  for (const mark of marks.values()) {
    if (!seen.has(mark.order) && mark.count !== 0) {
      mark.count = 0;
      mark.updatedAt = tick;
    }
  }
  return [...marks.values()];
}

/** 人数多的在前。人数相同的，更晚变成这个人数的在前。 */
export function rankCounts(rows: readonly CountMark[]): CountMark[] {
  return [...rows].sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt || a.order - b.order);
}

export function moveOf(kind: string, attrs: Attrs, roll = 0): Move {
  const category = categoryById.get(kind);
  if (!category) throw new Error(`没有这种出法：${kind}`);
  return category.decide(readMemory(attrs), roll);
}

/** 掷出的数小于概率时，把这一手合作与背叛对调。 */
export function flipMove(move: Move, roll: number, probability: number): Move {
  if (!(roll < probability)) return move;
  return move === "C" ? "D" : "C";
}

export function tftIntro(params: TftParams): string {
  const roster = tftCategories
    .map((category, index) => `${index + 1} ${category.label} ${params.counts[category.id] ?? 0}人`)
    .join("，");
  return [
    `以牙还牙。初始人数：${roster}。`,
    `每 ${params.every} 拍开始繁衍一次：淘汰当时得分最低的 ${params.eliminate} 人，再从剩下的人里抽亲代，补回同样人数的纯策略。种子 ${params.seed}。`,
    "抽亲代时先减去存活者都有的那一截分数。最低的人留 1 份，每高出 1 分再多 1 份，然后按份数归一化。",
    "繁殖这一拍不再对局。淘汰和新生儿到下一拍开始才入场。落地后所有人只留下策略，关系和得分都清空。只剩一种策略时提前结束。到了繁衍淘汰那一拍，最高分和最低分的差距不超过最高分的死区比例时也提前结束。",
    "每人在普通拍和其他所有人各打一局。都合作各得 3，都背叛各得 1，单方背叛时背叛者得 5、合作者得 0。",
    `同质化看上一拍合作占外界对待的比例，达到 ${formatRatio(inputRatio(params))} 才合作。比例越低越乐观，越高越悲观。没有记录时合作。`,
    `每个出牌决定有 ${formatRatio(inputFlip(params))} 的概率翻成相反的一手。记下来的是实际打出的那一手。`,
    `分数死区是最高分的 ${formatRatio(inputDead(params))}。繁衍那一拍最高分减最低分不超过它，就当作分数相同。`,
  ].join("\n");
}

export function createTftWorld(input: TftParams = defaultTftParams): World {
  const params = normalizeTftParams(input);
  const world = createWorld();
  world.name = "以牙还牙";
  world.seed = params.seed;
  for (const [index, category] of tftCategories.entries()) {
    const count = params.counts[category.id] ?? 0;
    for (let n = 1; n <= count; n += 1) {
      addEntity(world, {
        id: `${category.id}#${n}`,
        attrs: { kind: category.id, label: category.label, order: index, score: 0 },
      });
    }
  }
  world.rules = [playRule(params), selectRule(params)];
  return world;
}

export function normalizeTftParams(input: TftParams): TftParams {
  const counts: Record<string, number> = {};
  for (const category of tftCategories) counts[category.id] = 0;
  for (const [key, raw] of Object.entries(input.counts)) {
    const id = resolveCategoryId(key);
    if (!Number.isInteger(raw) || raw < 0) throw new Error(`${key} 的人数要是非负整数`);
    counts[id] = raw;
  }
  const population = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (population < 2) throw new Error("至少要有 2 个人");
  if (!Number.isInteger(input.every) || input.every < 1) throw new Error("繁衍间隔要是正整数");
  if (!Number.isInteger(input.eliminate) || input.eliminate < 0) throw new Error("淘汰人数要是非负整数");
  if (input.eliminate >= population) throw new Error(`淘汰人数要小于总人数 ${population}`);
  if (!Number.isInteger(input.seed)) throw new Error("种子要是整数");
  const ratio = inputRatio(input);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("同质化的判断比例要在 0 和 1 之间");
  const flip = inputFlip(input);
  if (!Number.isFinite(flip) || flip < 0 || flip > 1) throw new Error("翻转概率要在 0 和 1 之间");
  const dead = inputDead(input);
  if (!Number.isFinite(dead) || dead < 0 || dead > 1) throw new Error("分数死区要是 0 到 1 之间的比例");
  return { counts, every: input.every, eliminate: input.eliminate, seed: input.seed, ratio, flip, dead };
}

function resolveCategoryId(key: string): string {
  if (/^\d+$/.test(key)) {
    const index = Number(key) - 1;
    const category = tftCategories[index];
    if (!category) throw new Error(`没有第 ${key} 个类别`);
    return category.id;
  }
  if (!categoryById.has(key)) throw new Error(`没有这个类别：${key}`);
  return key;
}

function playRule(params: TftParams): WorldRule {
  return {
    name: "play",
    run(ctx) {
      if (isSelectionTick(ctx.tick, params.every)) return;
      const people = ctx.world.entities();
      const outside = outsideTreatment(people, (from, to) => ctx.world.relation(from, to).attrs);
      const ratio = inputRatio(params);
      const flip = inputFlip(params);
      for (let i = 0; i < people.length; i += 1) {
        for (let j = i + 1; j < people.length; j += 1) {
          const left = people[i];
          const right = people[j];
          if (!left || !right) continue;
          const leftKind = kindOf(left.attrs.kind);
          const rightKind = kindOf(right.attrs.kind);
          const leftMemory = withOutside(readMemory(ctx.world.relation(left.id, right.id).attrs), outside.get(left.id), ratio);
          const rightMemory = withOutside(readMemory(ctx.world.relation(right.id, left.id).attrs), outside.get(right.id), ratio);
          const leftMove = flipMove(
            leftKind.decide(leftMemory, unitRandom(ctx.seed, [ctx.tick, left.id, right.id, "L"])),
            unitRandom(ctx.seed, [ctx.tick, left.id, right.id, "flip", "L"]),
            flip,
          );
          const rightMove = flipMove(
            rightKind.decide(rightMemory, unitRandom(ctx.seed, [ctx.tick, left.id, right.id, "R"])),
            unitRandom(ctx.seed, [ctx.tick, left.id, right.id, "flip", "R"]),
            flip,
          );
          left.add("score", payoff(leftMove, rightMove));
          right.add("score", payoff(rightMove, leftMove));
          remember(ctx.world.relation(left.id, right.id), leftMemory, leftMove, rightMove, leftKind.id === "burster");
          remember(ctx.world.relation(right.id, left.id), rightMemory, rightMove, leftMove, rightKind.id === "burster");
        }
      }
    },
  };
}

function selectRule(params: TftParams): WorldRule {
  return {
    name: "select",
    run(ctx) {
      if (!isSelectionTick(ctx.tick, params.every) || params.eliminate === 0) return;
      const people = ctx.world.entities();
      if (people.length <= params.eliminate) {
        throw new Error(`人数 ${people.length} 不够淘汰 ${params.eliminate} 人`);
      }
      const ranked = [...people].sort((a, b) => scoreOf(a.attrs.score) - scoreOf(b.attrs.score) || compareText(a.id, b.id));
      const doomed = ranked.slice(0, params.eliminate);
      const survivors = ranked.slice(params.eliminate).sort((a, b) => compareText(a.id, b.id));
      for (const entity of doomed) ctx.remove(entity.id);
      const used = new Set(people.map((entity) => entity.id));
      const weights = spreadWeights(survivors.map((entity) => scoreOf(entity.attrs.score)));
      for (let n = 0; n < doomed.length; n += 1) {
        const parent = survivors[weightedIndex(weights, unitRandom(ctx.seed, [ctx.tick, "birth", n]))];
        if (!parent) continue;
        const kind = typeof parent.attrs.kind === "string" ? parent.attrs.kind : "x";
        const label = typeof parent.attrs.label === "string" ? parent.attrs.label : kind;
        const order = typeof parent.attrs.order === "number" ? parent.attrs.order : 0;
        ctx.spawn({ id: nextId(used, kind), attrs: { kind, label, order, score: 0 } });
      }
      for (const entity of survivors) entity.set("score", 0);
      ctx.clearRelations();
    },
  };
}

function isSelectionTick(tick: number, every: number): boolean {
  return tick > 0 && tick % every === 0;
}

/** 繁衍拍开始时，这一整轮的得分已经打完。差距不超过最高分的死区比例，就当作分数相同。 */
export function sameScoresAtSelection(world: World, every: number, dead = 0): boolean {
  if (!isSelectionTick(world.tick, every)) return false;
  const scores = listEntities(world).map((entity) => scoreOf(entity.attrs.score));
  if (scores.length === 0) return false;
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  if (high === 0) return true;
  return high - low <= dead * high + 1e-9;
}

function kindOf(value: unknown): TftCategory {
  const id = typeof value === "string" ? value : "";
  const category = categoryById.get(id);
  if (!category) throw new Error(`没有这种出法：${id}`);
  return category;
}

function scoreOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** 减去共同的最低分，再给每人加 1 份，避免最低者权重为 0。加权时按总和归一化。 */
export function spreadWeights(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const floor = Math.min(...scores);
  return scores.map((score) => Math.max(0, score - floor) + 1);
}

function readMemory(attrs: Readonly<Attrs>): Memory {
  const move = (value: unknown): Move | undefined => (value === "C" || value === "D" ? value : undefined);
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    t: num(attrs.t),
    lastOpp: move(attrs.lastOpp),
    prevOpp: move(attrs.prevOpp),
    lastMine: move(attrs.lastMine),
    oppC: num(attrs.oppC),
    oppD: num(attrs.oppD),
    opp1: move(attrs.opp1),
    opp2: move(attrs.opp2),
    worldC: num(attrs.worldC),
    worldD: num(attrs.worldD),
    ratio: typeof attrs.ratio === "number" ? attrs.ratio : 0.5,
    recent: typeof attrs.recent === "string" ? attrs.recent : "",
    burst: attrs.burst === 1 || attrs.burst === true,
  };
}

function burstTriggered(recent: string): boolean {
  const window = recent.slice(-5);
  let betrayed = 0;
  for (let i = 0; i < window.length; i += 1) if (window[i] === "D") betrayed += 1;
  return betrayed >= 3;
}

function seesCooperation(memory: Memory): boolean {
  const total = memory.worldC + memory.worldD;
  if (total === 0) return true;
  return memory.worldC + 1e-9 >= memory.ratio * total;
}

function inputRatio(params: Pick<TftParams, "ratio">): number {
  return params.ratio ?? 0.5;
}

function inputFlip(params: Pick<TftParams, "flip">): number {
  return params.flip ?? 0;
}

function inputDead(params: Pick<TftParams, "dead">): number {
  return params.dead ?? 0;
}

function formatRatio(ratio: number): string {
  return String(Math.round(ratio * 1e6) / 1e6);
}

/** 结尾排名附上的这次运行参数。endedAt 是排名所取的那一拍。 */
export function tftRankingNote(params: TftParams, plannedTicks: number, endedAt: number): string {
  return [
    `初始人数：${describeCounts(params)}。`,
    `每 ${params.every} 拍繁衍一次，淘汰当时得分最低的 ${params.eliminate} 人，再按扣掉共同分数后的份数抽亲代。种子 ${params.seed}。`,
    `同质化的判断比例是 ${formatRatio(inputRatio(params))}，上一拍合作占比达到它才合作。`,
    `每个出牌决定有 ${formatRatio(inputFlip(params))} 的概率翻成相反的一手。`,
    `分数死区是最高分的 ${formatRatio(inputDead(params))}。繁衍那一拍最高分减最低分不超过它，就当作分数相同。`,
    `计划跑 ${plannedTicks} 拍，排名取第 ${endedAt} 拍开始时的人数。`,
  ].join("\n");
}

function describeCounts(params: TftParams): string {
  const counts = tftCategories.map((category) => params.counts[category.id] ?? 0);
  const first = counts[0] ?? 0;
  if (counts.every((count) => count === first)) return `每类 ${first} 人`;
  const present = tftCategories
    .filter((category) => (params.counts[category.id] ?? 0) > 0)
    .map((category) => `${category.label} ${params.counts[category.id]} 人`);
  if (present.length === 0) return "每类 0 人";
  return `${present.join("，")}。没写出的类别是 0 人`;
}

function outsideTreatment(
  people: readonly { id: string; attrs: Readonly<Attrs> }[],
  relationAttrs: (from: string, to: string) => Readonly<Attrs>,
): Map<string, { worldC: number; worldD: number }> {
  const totals = new Map<string, { worldC: number; worldD: number }>();
  for (const person of people) {
    if (person.attrs.kind !== "homogenized") continue;
    let worldC = 0;
    let worldD = 0;
    for (const other of people) {
      if (other.id === person.id) continue;
      const last = readMemory(relationAttrs(person.id, other.id)).lastOpp;
      if (last === "C") worldC += 1;
      else if (last === "D") worldD += 1;
    }
    totals.set(person.id, { worldC, worldD });
  }
  return totals;
}

function withOutside(memory: Memory, outside: { worldC: number; worldD: number } | undefined, ratio: number): Memory {
  return { ...memory, ...(outside ?? {}), ratio };
}

function remember(
  relation: { set: (key: string, value: string | number) => void },
  memory: Memory,
  mine: Move,
  opp: Move,
  trackBurst: boolean,
): void {
  if (memory.lastOpp) relation.set("prevOpp", memory.lastOpp);
  relation.set("lastOpp", opp);
  relation.set("lastMine", mine);
  relation.set("t", memory.t + 1);
  relation.set("oppC", memory.oppC + (opp === "C" ? 1 : 0));
  relation.set("oppD", memory.oppD + (opp === "D" ? 1 : 0));
  if (memory.t === 1) relation.set("opp1", opp);
  if (memory.t === 2) relation.set("opp2", opp);
  if (!trackBurst) return;
  const recent = `${memory.recent}${opp}`.slice(-5);
  relation.set("recent", recent);
  if (memory.burst || burstTriggered(recent)) relation.set("burst", 1);
}

function payoff(me: Move, opp: Move): number {
  if (me === "C" && opp === "C") return 3;
  if (me === "D" && opp === "C") return 5;
  if (me === "C" && opp === "D") return 0;
  return 1;
}

function nextId(used: Set<string>, kind: string): string {
  let n = 1;
  while (used.has(`${kind}#${n}`)) n += 1;
  const id = `${kind}#${n}`;
  used.add(id);
  return id;
}

function weightedIndex(weights: number[], unit: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 0) return 0;
  if (total <= 0) return Math.min(weights.length - 1, Math.floor(unit * weights.length));
  let cursor = unit * total;
  for (let i = 0; i < weights.length; i += 1) {
    cursor -= weights[i] ?? 0;
    if (cursor < 0) return i;
  }
  return weights.length - 1;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function unitRandom(seed: number, parts: readonly (string | number)[]): number {
  let hash = seed >>> 0;
  const mix = (value: number): number => {
    let x = value >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  };
  hash = mix(hash);
  for (const part of parts) {
    if (typeof part === "number") {
      hash = mix(hash ^ mix(part));
      continue;
    }
    for (let i = 0; i < part.length; i += 1) hash = mix(hash ^ part.charCodeAt(i));
  }
  return hash / 4294967296;
}
