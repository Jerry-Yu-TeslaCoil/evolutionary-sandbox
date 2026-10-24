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
  /** 上一拍见过的人里，合作、背叛的次数。同质化把这些人合成一笔账。 */
  worldC: number;
  worldD: number;
  /** 同质化继续合作所需的最低合作占比。 */
  ratio: number;
  /** 爆发者记住的最近对手出法，只留回看的那几次。 */
  recent: string;
  /** 回看次数里被这个人背叛已达到规定次数，此后只对这个人背叛。 */
  burst: boolean;
  /** 爆发者回看的最近次数。 */
  burstWindow: number;
  /** 回看里要达到的背叛次数。 */
  burstStrikes: number;
  /** 最近一次和这个人打的拍数。同质化只统计上一拍。 */
  met?: number;
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
  /** 双方合作时，各自沿冻结距离向对方移动的比例。 */
  approach?: number;
  /** 双方背叛时，各自沿冻结距离向对方移动的比例。缺省 0。 */
  coexist?: number;
  /** 单方面背叛时，背叛者沿冻结距离向对方移动的比例。 */
  follow?: number;
  /** 单方面背叛时，被背叛者离开对方的比例。负数表示反而靠近。 */
  flee?: number;
  /** 每人挑选的最近对手占其他人的比例。名额向下取整。缺省 1/3。 */
  near?: number;
  /** 从最近名额剩下的对手里再随机抽的比例。名额向下取整。缺省 0。 */
  stray?: number;
  /** 爆发者回看的最近次数。缺省 5。 */
  window?: number;
  /** 爆发者在回看里要达到的背叛次数。缺省 3。 */
  strikes?: number;
}

const opening = (moves: readonly Move[], memory: Memory, after: (memory: Memory) => Move): Move => {
  if (memory.t < moves.length) return moves[memory.t] ?? "D";
  return after(memory);
};

/** 对方上一手背叛时仍合作的概率。对当前得分表，广泛用的是 1/3。 */
const forgivingChance = 1 / 3;
/** 归一化之后，新生儿离亲代的最远距离。最远的存活者离中心是 1。 */
export const birthReach = 0.05;
const defaultBurstWindow = 5;
const defaultBurstStrikes = 3;

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
    decide: (memory) => (memory.burst || burstTriggered(memory) ? "D" : "C"),
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
  approach: 0.2,
  coexist: 0,
  follow: 0.15,
  flee: 0.45,
  near: 1 / 3,
  stray: 0,
  window: defaultBurstWindow,
  strikes: defaultBurstStrikes,
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
    `每一拍结束时，把所有还在场的人平移、缩放到离中心最远的人为 1，方向和距离比例保持不变。到点这一拍不再对局。淘汰人数是 0 时，人不淘汰、不出生，关系和得分都留着。淘汰人数大于 0 时，再淘汰和补人；落地后所有人只留下策略，关系和得分都清空。新生儿落在亲代旁边，距离不超过这个尺度的 ${formatRatio(birthReach)}。只剩一种策略时提前结束。到了这一拍，最高分和最低分的差距不超过最高分的死区比例时也提前结束。`,
    `每人在普通拍先和当时离自己最近的一部分人打。这部分是其他人的 ${formatRatio(inputNear(params))}，名额向下取整。再从剩下的人里按 ${formatRatio(inputStray(params))} 随机抽，名额同样向下取整，不管他们离多远。两边的名额都是 0 时这一拍不打。只要有一方把对方算进来，两人就打。都合作各得 3，都背叛各得 1，单方背叛时背叛者得 5、合作者得 0。`,
    `同质化看上一拍见过的人里，合作占多少，达到 ${formatRatio(inputRatio(params))} 才合作。比例越低越乐观，越高越悲观。没有记录时合作。`,
    `爆发者对同一个人，最近 ${inputWindow(params)} 次里被背叛达到 ${inputStrikes(params)} 次，之后只对这个人背叛。`,
    `每个出牌决定有 ${formatRatio(inputFlip(params))} 的概率翻成相反的一手。记下来的是实际打出的那一手。`,
    `分数死区是最高分的 ${formatRatio(inputDead(params))}。繁衍那一拍最高分减最低分不超过它，就当作分数相同。`,
    motionSentence(params),
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
      const id = `${category.id}#${n}`;
      const spot = place(params.seed, 0, id);
      addEntity(world, {
        id,
        attrs: { kind: category.id, label: category.label, order: index, score: 0, x: spot.x, y: spot.y },
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
  const near = inputNear(input);
  if (!Number.isFinite(near) || near < 0 || near > 1) throw new Error("最近对手的比例要在 0 和 1 之间");
  const stray = inputStray(input);
  if (!Number.isFinite(stray) || stray < 0 || stray > 1) throw new Error("意外相遇的比例要在 0 和 1 之间");
  const window = inputWindow(input);
  const strikes = inputStrikes(input);
  if (!Number.isInteger(window) || window < 1) throw new Error("爆发者回看的次数要是正整数");
  if (!Number.isInteger(strikes) || strikes < 1) throw new Error("爆发者的背叛次数要是正整数");
  if (strikes > window) throw new Error("爆发者的背叛次数不能大于回看次数");
  const space = spaceOf(input);
  for (const [name, value] of [
    ["靠近系数", space.approach],
    ["共存系数", space.coexist],
    ["跟随系数", space.follow],
    ["远离系数", space.flee],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${name}要是数字`);
  }
  return {
    counts,
    every: input.every,
    eliminate: input.eliminate,
    seed: input.seed,
    ratio,
    flip,
    dead,
    near,
    stray,
    window,
    strikes,
    ...space,
  };
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

/** 其他人里最近的一部分，比例 near，名额向下取整。 */
export function nearestCount(population: number, near = 1 / 3): number {
  if (population <= 1 || near <= 0) return 0;
  return Math.min(population - 1, Math.floor((population - 1) * near + 1e-9));
}

/** 最近名额之外再随机抽的人数。比例 stray 乘的是剩下的对手，名额向下取整。 */
export function strayCount(population: number, near = 1 / 3, stray = 0): number {
  if (population <= 1 || stray <= 0) return 0;
  const rest = population - 1 - nearestCount(population, near);
  if (rest <= 0) return 0;
  return Math.min(rest, Math.floor(rest * stray + 1e-9));
}

function pairKey(left: string, right: string): string {
  return compareText(left, right) <= 0 ? `${left}\0${right}` : `${right}\0${left}`;
}

function meetingKeys(
  people: readonly { id: string; attrs: Readonly<Attrs> }[],
  near: number,
  stray: number,
  seed: number,
  tick: number,
): Set<string> {
  const points = people.map((person) => ({ id: person.id, x: coordOf(person.attrs.x), y: coordOf(person.attrs.y) }));
  const quota = nearestCount(points.length, near);
  const extra = strayCount(points.length, near, stray);
  const meetings = new Set<string>();
  for (const person of points) {
    const others = points
      .filter((other) => other.id !== person.id)
      .sort((a, b) => {
        const gap = Math.hypot(a.x - person.x, a.y - person.y) - Math.hypot(b.x - person.x, b.y - person.y);
        return gap !== 0 ? gap : compareText(a.id, b.id);
      });
    for (const other of others.slice(0, quota)) meetings.add(pairKey(person.id, other.id));
    const drawn = others
      .slice(quota)
      .map((other) => ({ id: other.id, roll: unitRandom(seed, [tick, person.id, other.id, "stray"]) }))
      .sort((a, b) => a.roll - b.roll || compareText(a.id, b.id))
      .slice(0, extra);
    for (const other of drawn) meetings.add(pairKey(person.id, other.id));
  }
  return meetings;
}

function playRule(params: TftParams): WorldRule {
  return {
    name: "play",
    run(ctx) {
      if (isSelectionTick(ctx.tick, params.every)) return;
      const people = ctx.world.entities();
      const meetings = meetingKeys(people, inputNear(params), inputStray(params), ctx.seed, ctx.tick);
      const outside = outsideTreatment(people, (from, to) => ctx.world.relation(from, to).attrs, ctx.tick);
      const ratio = inputRatio(params);
      const window = inputWindow(params);
      const strikes = inputStrikes(params);
      const flip = inputFlip(params);
      const space = spaceOf(params);
      const movedX = new Map<string, number>();
      const movedY = new Map<string, number>();
      const pushMove = (id: string, x: number, y: number) => {
        movedX.set(id, (movedX.get(id) ?? 0) + x);
        movedY.set(id, (movedY.get(id) ?? 0) + y);
      };
      for (let i = 0; i < people.length; i += 1) {
        for (let j = i + 1; j < people.length; j += 1) {
          const left = people[i];
          const right = people[j];
          if (!left || !right || !meetings.has(pairKey(left.id, right.id))) continue;
          const leftKind = kindOf(left.attrs.kind);
          const rightKind = kindOf(right.attrs.kind);
          const leftMemory = withOutside(readMemory(ctx.world.relation(left.id, right.id).attrs), outside.get(left.id), ratio, window, strikes);
          const rightMemory = withOutside(readMemory(ctx.world.relation(right.id, left.id).attrs), outside.get(right.id), ratio, window, strikes);
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
          const leftScale = towardScale(leftMove, rightMove, space);
          const rightScale = towardScale(rightMove, leftMove, space);
          const leftX = coordOf(left.attrs.x);
          const leftY = coordOf(left.attrs.y);
          const rightX = coordOf(right.attrs.x);
          const rightY = coordOf(right.attrs.y);
          pushMove(left.id, (rightX - leftX) * leftScale, (rightY - leftY) * leftScale);
          pushMove(right.id, (leftX - rightX) * rightScale, (leftY - rightY) * rightScale);
          remember(ctx.world.relation(left.id, right.id), leftMemory, leftMove, rightMove, leftKind.id === "burster", ctx.tick);
          remember(ctx.world.relation(right.id, left.id), rightMemory, rightMove, leftMove, rightKind.id === "burster", ctx.tick);
        }
      }
      const fitted = normalizePositions(people.map((person) => ({
        x: coordOf(person.attrs.x) + (movedX.get(person.id) ?? 0),
        y: coordOf(person.attrs.y) + (movedY.get(person.id) ?? 0),
      })));
      for (let i = 0; i < people.length; i += 1) {
        const person = people[i];
        const spot = fitted[i];
        if (!person || !spot) continue;
        person.set("x", spot.x);
        person.set("y", spot.y);
      }
    },
  };
}

function selectRule(params: TftParams): WorldRule {
  return {
    name: "select",
    run(ctx) {
      if (!isSelectionTick(ctx.tick, params.every)) return;
      const people = ctx.world.entities();
      if (params.eliminate === 0) {
        placeNormalized(people);
        return;
      }
      if (people.length <= params.eliminate) {
        throw new Error(`人数 ${people.length} 不够淘汰 ${params.eliminate} 人`);
      }
      const ranked = [...people].sort((a, b) => scoreOf(a.attrs.score) - scoreOf(b.attrs.score) || compareText(a.id, b.id));
      const doomed = ranked.slice(0, params.eliminate);
      const survivors = ranked.slice(params.eliminate).sort((a, b) => compareText(a.id, b.id));
      for (const entity of doomed) ctx.remove(entity.id);
      const fitted = placeNormalized(survivors);
      const used = new Set(people.map((entity) => entity.id));
      const weights = spreadWeights(survivors.map((entity) => scoreOf(entity.attrs.score)));
      for (let n = 0; n < doomed.length; n += 1) {
        const parentIndex = weightedIndex(weights, unitRandom(ctx.seed, [ctx.tick, "birth", n]));
        const parent = survivors[parentIndex];
        const origin = fitted[parentIndex];
        if (!parent || !origin) continue;
        const kind = typeof parent.attrs.kind === "string" ? parent.attrs.kind : "x";
        const label = typeof parent.attrs.label === "string" ? parent.attrs.label : kind;
        const order = typeof parent.attrs.order === "number" ? parent.attrs.order : 0;
        const id = nextId(used, kind);
        const spot = beside(origin, birthOffset(ctx.seed, ctx.tick, id));
        ctx.spawn({ id, attrs: { kind, label, order, score: 0, x: spot.x, y: spot.y } });
      }
      for (const entity of survivors) entity.set("score", 0);
      ctx.clearRelations();
    },
  };
}

function placeNormalized(people: readonly { id: string; attrs: Readonly<Attrs>; set: (key: string, value: string | number) => void }[]): { x: number; y: number }[] {
  const fitted = normalizePositions(people.map((entity) => ({ x: coordOf(entity.attrs.x), y: coordOf(entity.attrs.y) })));
  for (let i = 0; i < people.length; i += 1) {
    const entity = people[i];
    const spot = fitted[i];
    if (!entity || !spot) continue;
    entity.set("x", spot.x);
    entity.set("y", spot.y);
  }
  return fitted;
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
    burstWindow: countAttr(attrs.burstWindow, defaultBurstWindow),
    burstStrikes: countAttr(attrs.burstStrikes, defaultBurstStrikes),
    met: typeof attrs.met === "number" ? attrs.met : undefined,
  };
}

function countAttr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function burstTriggered(memory: Memory): boolean {
  const window = memory.recent.slice(-memory.burstWindow);
  let betrayed = 0;
  for (let i = 0; i < window.length; i += 1) if (window[i] === "D") betrayed += 1;
  return betrayed >= memory.burstStrikes;
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

function inputNear(params: Pick<TftParams, "near">): number {
  return params.near ?? defaultTftParams.near ?? 1 / 3;
}

function inputStray(params: Pick<TftParams, "stray">): number {
  return params.stray ?? defaultTftParams.stray ?? 0;
}

function inputWindow(params: Pick<TftParams, "window">): number {
  return params.window ?? defaultTftParams.window ?? defaultBurstWindow;
}

function inputStrikes(params: Pick<TftParams, "strikes">): number {
  return params.strikes ?? defaultTftParams.strikes ?? defaultBurstStrikes;
}

function spaceOf(params: Pick<TftParams, "approach" | "coexist" | "follow" | "flee">): {
  approach: number;
  coexist: number;
  follow: number;
  flee: number;
} {
  return {
    approach: params.approach ?? defaultTftParams.approach ?? 0.2,
    coexist: params.coexist ?? defaultTftParams.coexist ?? 0,
    follow: params.follow ?? defaultTftParams.follow ?? 0.15,
    flee: params.flee ?? defaultTftParams.flee ?? 0.45,
  };
}

function motionSentence(params: TftParams): string {
  const space = spaceOf(params);
  return [
    `靠近系数 ${formatRatio(space.approach)}，共存系数 ${formatRatio(space.coexist)}，跟随系数 ${formatRatio(space.follow)}，远离系数 ${formatRatio(space.flee)}。`,
    "走的距离是这一拍开始时两人的距离乘上对应系数。走完后把所有人平移、缩放到离中心最远的人为 1。只有这一拍真正对上的人才会走动。合作时各自走近，互相背叛时也按共存系数走近。单方面背叛时，被背叛的人走开，背叛的人跟着走近。系数为负时方向相反。",
  ].join("");
}

function place(seed: number, tick: number, id: string): { x: number; y: number } {
  return {
    x: unitRandom(seed, [tick, id, "x"]),
    y: unitRandom(seed, [tick, id, "y"]),
  };
}

/** 平移到中心，再缩放到离中心最远的点距离为 1。大家都在同一点时放到原点。 */
export function normalizePositions(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const located = points.map((point) => ({
    x: Number.isFinite(point.x) ? point.x : 0,
    y: Number.isFinite(point.y) ? point.y : 0,
  }));
  let peak = 0;
  for (const point of located) peak = Math.max(peak, Math.abs(point.x), Math.abs(point.y));
  const scale = peak > 1 ? peak : 1;
  const reduced = located.map((point) => ({ x: point.x / scale, y: point.y / scale }));
  let sx = 0;
  let sy = 0;
  for (const point of reduced) {
    sx += point.x;
    sy += point.y;
  }
  const cx = sx / reduced.length;
  const cy = sy / reduced.length;
  let radius = 0;
  const shifted = reduced.map((point) => {
    const x = point.x - cx;
    const y = point.y - cy;
    radius = Math.max(radius, Math.hypot(x, y));
    return { x, y };
  });
  if (radius === 0) return shifted.map(() => ({ x: 0, y: 0 }));
  return shifted.map((point) => ({ x: point.x / radius, y: point.y / radius }));
}

function birthOffset(seed: number, tick: number, id: string): { x: number; y: number } {
  const angle = unitRandom(seed, [tick, id, "birth", "angle"]) * Math.PI * 2;
  const reach = unitRandom(seed, [tick, id, "birth", "reach"]) * birthReach;
  return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
}

function beside(origin: { x: number; y: number }, offset: { x: number; y: number }): { x: number; y: number } {
  return { x: origin.x + offset.x, y: origin.y + offset.y };
}

function coordOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export interface CohortSpacing {
  order: number;
  label: string;
  count: number;
  /** 同一种策略内部两两平均距离。少于 2 人时没有。 */
  cohesion?: number;
  /** 到其他种群成员的平均距离。 */
  outward?: number;
}

export interface PopulationSpacing {
  cohorts: CohortSpacing[];
  separations: { left: string; right: string; mean: number }[];
}

function located(attrs: Readonly<Attrs>): { x: number; y: number } {
  return { x: coordOf(attrs.x), y: coordOf(attrs.y) };
}

function span(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 按策略统计内聚，以及各种群之间的平均距离。坐标是调用时的位置。 */
export function populationSpacing(people: readonly { id: string; attrs: Readonly<Attrs> }[]): PopulationSpacing {
  const groups = new Map<number, { label: string; points: { x: number; y: number }[] }>();
  for (const person of people) {
    const order = person.attrs.order;
    const label = person.attrs.label;
    if (typeof order !== "number" || typeof label !== "string") continue;
    const group = groups.get(order) ?? { label, points: [] };
    group.points.push(located(person.attrs));
    groups.set(order, group);
  }
  const orders = [...groups.keys()].sort((a, b) => a - b);
  const cohorts: CohortSpacing[] = orders.map((order) => {
    const group = groups.get(order);
    const points = group?.points ?? [];
    const internal: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const left = points[i];
        const right = points[j];
        if (left && right) internal.push(span(left, right));
      }
    }
    const external: number[] = [];
    for (const otherOrder of orders) {
      if (otherOrder === order) continue;
      const others = groups.get(otherOrder)?.points ?? [];
      for (const point of points) for (const other of others) external.push(span(point, other));
    }
    return {
      order,
      label: group?.label ?? "",
      count: points.length,
      cohesion: average(internal),
      outward: average(external),
    };
  });
  const separations: PopulationSpacing["separations"] = [];
  for (let i = 0; i < orders.length; i += 1) {
    for (let j = i + 1; j < orders.length; j += 1) {
      const leftOrder = orders[i];
      const rightOrder = orders[j];
      if (leftOrder === undefined || rightOrder === undefined) continue;
      const left = groups.get(leftOrder);
      const right = groups.get(rightOrder);
      const gaps: number[] = [];
      for (const a of left?.points ?? []) for (const b of right?.points ?? []) gaps.push(span(a, b));
      const mean = average(gaps);
      if (mean === undefined || !left || !right) continue;
      separations.push({ left: left.label, right: right.label, mean });
    }
  }
  separations.sort((a, b) => a.mean - b.mean || compareText(a.left, b.left) || compareText(a.right, b.right));
  return { cohorts, separations };
}

export function formatPopulationSpacing(spacing: PopulationSpacing): string {
  const scale = spacingPeak(spacing);
  const unit = (value: number) => formatDistance(scale === 0 ? 0 : value / scale);
  const lines = ["种群距离", "距离按最远的一组缩放到 1。内聚是同一种策略内部的平均距离，越小越挤在一起。"];
  const huddled = spacing.cohorts
    .filter((row): row is CohortSpacing & { cohesion: number } => row.cohesion !== undefined)
    .sort((a, b) => a.cohesion - b.cohesion || a.order - b.order);
  const nearestPair = spacing.separations[0];
  const farthestPair = spacing.separations[spacing.separations.length - 1];
  const tightest = huddled[0];
  if (tightest) lines.push(`最紧的是 ${tightest.label}，内聚 ${unit(tightest.cohesion)}。`);
  if (huddled.length === 0) lines.push("没有哪种策略有 2 个以上的人，算不出内聚。");
  if (nearestPair) lines.push(`靠得最近的两种是 ${nearestPair.left} 和 ${nearestPair.right}，${unit(nearestPair.mean)}。`);
  if (farthestPair && farthestPair !== nearestPair) {
    lines.push(`离得最远的两种是 ${farthestPair.left} 和 ${farthestPair.right}，${unit(farthestPair.mean)}。`);
  }
  for (const row of huddled) {
    const touched = spacing.separations.filter((gap) => gap.left === row.label || gap.right === row.label);
    const nearest = touched[0];
    const farthest = touched[touched.length - 1];
    const nameOf = (gap: { left: string; right: string }) => (gap.left === row.label ? gap.right : gap.left);
    const outward = row.outward === undefined ? "" : `  到其他种群 ${unit(row.outward)}`;
    const nearText = nearest ? `  最近 ${nameOf(nearest)} ${unit(nearest.mean)}` : "";
    const farText = farthest && farthest !== nearest ? `  最远 ${nameOf(farthest)} ${unit(farthest.mean)}` : "";
    lines.push(`  ${row.label}  内聚 ${unit(row.cohesion)}${outward}${nearText}${farText}  ${row.count} 人`);
  }
  return lines.join("\n");
}

function spacingPeak(spacing: PopulationSpacing): number {
  let peak = 0;
  for (const row of spacing.cohorts) {
    if (row.cohesion !== undefined) peak = Math.max(peak, row.cohesion);
    if (row.outward !== undefined) peak = Math.max(peak, row.outward);
  }
  for (const gap of spacing.separations) peak = Math.max(peak, gap.mean);
  return peak;
}

function formatDistance(value: number): string {
  return value.toFixed(3);
}

function towardScale(mine: Move, opp: Move, space: { approach: number; coexist: number; follow: number; flee: number }): number {
  if (mine === "C" && opp === "C") return space.approach;
  if (mine === "D" && opp === "D") return space.coexist;
  if (mine === "D" && opp === "C") return space.follow;
  return -space.flee;
}

function formatRatio(ratio: number): string {
  return String(Math.round(ratio * 1e6) / 1e6);
}

/** 结尾排名附上的这次运行参数。endedAt 是排名所取的那一拍。 */
export function tftRankingNote(params: TftParams, plannedTicks: number, endedAt: number): string {
  return [
    `初始人数：${describeCounts(params)}。`,
    `每 ${params.every} 拍繁衍一次，淘汰当时得分最低的 ${params.eliminate} 人，再按扣掉共同分数后的份数抽亲代。种子 ${params.seed}。`,
    "每一拍都把还在场的人平移、缩放到离中心最远的人为 1。淘汰人数是 0 时不淘汰、不出生。有淘汰时，新生儿落在亲代旁边。",
    `同质化的判断比例是 ${formatRatio(inputRatio(params))}，上一拍见过的人里合作占比达到它才合作。`,
    `每个出牌决定有 ${formatRatio(inputFlip(params))} 的概率翻成相反的一手。`,
    `分数死区是最高分的 ${formatRatio(inputDead(params))}。繁衍那一拍最高分减最低分不超过它，就当作分数相同。`,
    `最近对手的比例是 ${formatRatio(inputNear(params))}，名额按其他人的人数向下取整。意外相遇再从剩下的人里随机抽 ${formatRatio(inputStray(params))}。`,
    `爆发者对同一个人，最近 ${inputWindow(params)} 次里被背叛达到 ${inputStrikes(params)} 次，之后只对这个人背叛。`,
    motionSentence(params),
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
  tick: number,
): Map<string, { worldC: number; worldD: number }> {
  const totals = new Map<string, { worldC: number; worldD: number }>();
  for (const person of people) {
    if (person.attrs.kind !== "homogenized") continue;
    let worldC = 0;
    let worldD = 0;
    for (const other of people) {
      if (other.id === person.id) continue;
      const memory = readMemory(relationAttrs(person.id, other.id));
      if (memory.met !== tick - 1) continue;
      if (memory.lastOpp === "C") worldC += 1;
      else if (memory.lastOpp === "D") worldD += 1;
    }
    totals.set(person.id, { worldC, worldD });
  }
  return totals;
}

function withOutside(
  memory: Memory,
  outside: { worldC: number; worldD: number } | undefined,
  ratio: number,
  burstWindow: number,
  burstStrikes: number,
): Memory {
  return { ...memory, ...(outside ?? {}), ratio, burstWindow, burstStrikes };
}

function remember(
  relation: { set: (key: string, value: string | number) => void },
  memory: Memory,
  mine: Move,
  opp: Move,
  trackBurst: boolean,
  tick: number,
): void {
  if (memory.lastOpp) relation.set("prevOpp", memory.lastOpp);
  relation.set("lastOpp", opp);
  relation.set("lastMine", mine);
  relation.set("t", memory.t + 1);
  relation.set("oppC", memory.oppC + (opp === "C" ? 1 : 0));
  relation.set("oppD", memory.oppD + (opp === "D" ? 1 : 0));
  relation.set("met", tick);
  if (memory.t === 1) relation.set("opp1", opp);
  if (memory.t === 2) relation.set("opp2", opp);
  if (!trackBurst) return;
  const recent = `${memory.recent}${opp}`.slice(-memory.burstWindow);
  relation.set("recent", recent);
  if (memory.burst || burstTriggered({ ...memory, recent })) relation.set("burst", 1);
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
