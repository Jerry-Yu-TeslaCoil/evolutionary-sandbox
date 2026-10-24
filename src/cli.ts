import { listEntities, listRelations, step, type Value, type World } from "./world.ts";
import { buildDemoWorld } from "./demo.ts";
import { createTftWorld, defaultTftParams, rankCounts, rememberCounts, sameScoresAtSelection, tftCategories, tftIntro, tftRankingNote, type CountMark, type TftParams } from "./tft.ts";

interface Options {
  world: "demo" | "tft";
  ticks?: number;
  every?: number;
  eliminate?: number;
  seed?: number;
  count?: number;
  ratio?: number;
  flip?: number;
  dead?: number;
  overrides: { key: string; count: number }[];
}

const demoIntro = [
  "每一拍先冻结实体和关系，再让每个策略各跑一次，最后一起落地。",
  "打印的是每一拍开始时的世界。这一拍写出的修改，要到下一拍开始才出现。",
  "alice 和 bob 每拍各让 prey 的体力 -1，两笔在落地时相加。",
  "alice 在第 0 拍写下 wave。bob 在第 1 拍开始时读到它，heard 出现在第 2 拍开始。",
  "prey 要到某一拍开始时体力已经 <= 0，才在这一拍结束时离场。",
].join("\n");

function parseOptions(argv: string[]): Options {
  const options: Options = { world: "tft", overrides: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log([
        "用法:",
        "  npm start -- --ticks 12",
        "  npm start -- --world demo",
        "  npm start -- --world tft --every 5 --eliminate 8 --count 3 --seed 1",
        "  npm start -- --n 1=5 --n tft=2",
        "  npm start -- --ratio 0.3",
        "  npm start -- --flip 0.05",
        "  npm start -- --dead 0.05",
        "",
        "--ratio 是同质化的判断比例，取 0 到 1，也可以写成分数。合作占比达到它才合作。越低越乐观，越高越悲观。默认 0.5。",
        "--flip 是每个出牌决定被翻转的概率，取 0 到 1，也可以写成分数。默认 0。",
        "--dead 是分数死区，取 0 到 1，也可以写成分数。繁衍那一拍最高分减最低分不超过最高分的这个比例，就当作分数相同并提前结束。默认 0。",
        "",
        "类别从 1 开始，也可以写 id：",
        tftCategories.map((category, index) => `  ${index + 1} ${category.id} ${category.label}`).join("\n"),
      ].join("\n"));
      process.exit(0);
    }
    const read = (name: string): string => {
      if (arg === name) {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error(`${name} 缺少取值`);
        return value;
      }
      if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      return "";
    };
    if (arg === "--world" || arg?.startsWith("--world=")) {
      const value = read("--world");
      if (value !== "demo" && value !== "tft") throw new Error("--world 只能是 tft 或 demo");
      options.world = value;
      continue;
    }
    if (arg === "--ticks" || arg?.startsWith("--ticks=")) {
      options.ticks = nonNegativeInt(read("--ticks"), "--ticks");
      continue;
    }
    if (arg === "--every" || arg?.startsWith("--every=")) {
      options.every = nonNegativeInt(read("--every"), "--every");
      continue;
    }
    if (arg === "--eliminate" || arg?.startsWith("--eliminate=")) {
      options.eliminate = nonNegativeInt(read("--eliminate"), "--eliminate");
      continue;
    }
    if (arg === "--seed" || arg?.startsWith("--seed=")) {
      options.seed = integerArg(read("--seed"), "--seed");
      continue;
    }
    if (arg === "--ratio" || arg?.startsWith("--ratio=")) {
      options.ratio = unitArg(read("--ratio"), "--ratio");
      continue;
    }
    if (arg === "--flip" || arg?.startsWith("--flip=")) {
      options.flip = unitArg(read("--flip"), "--flip");
      continue;
    }
    if (arg === "--dead" || arg?.startsWith("--dead=")) {
      options.dead = unitArg(read("--dead"), "--dead");
      continue;
    }
    if (arg === "--count" || arg?.startsWith("--count=")) {
      options.count = nonNegativeInt(read("--count"), "--count");
      continue;
    }
    if (arg === "--n" || arg?.startsWith("--n=")) {
      const raw = read("--n");
      const [key, countText] = raw.split("=");
      if (!key || countText === undefined) throw new Error("--n 要写成 类别=人数，例如 1=4 或 tft=4");
      options.overrides.push({ key, count: nonNegativeInt(countText, "--n") });
      continue;
    }
    throw new Error(`未知参数 ${arg ?? ""}`);
  }
  return options;
}

function nonNegativeInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 要是非负整数`);
  return value;
}

function integerArg(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} 要是整数`);
  return value;
}

function unitArg(raw: string, name: string): number {
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(raw);
  let value: number;
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) throw new Error(`${name} 的分母不能是 0`);
    value = Number(fraction[1]) / denominator;
  } else {
    value = Number(raw);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} 要是 0 到 1 之间的数，例如 0.05 或 1/20`);
  return value;
}

function tftParams(options: Options): TftParams {
  const counts = { ...defaultTftParams.counts };
  if (options.count !== undefined) {
    for (const category of tftCategories) counts[category.id] = options.count;
  }
  for (const override of options.overrides) counts[override.key] = override.count;
  return {
    counts,
    every: options.every ?? defaultTftParams.every,
    eliminate: options.eliminate ?? defaultTftParams.eliminate,
    seed: options.seed ?? defaultTftParams.seed,
    ratio: options.ratio ?? defaultTftParams.ratio,
    flip: options.flip ?? defaultTftParams.flip,
    dead: options.dead ?? defaultTftParams.dead,
  };
}

function formatValue(value: Value): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function formatAttrs(attrs: Readonly<Record<string, Value>>): string {
  return Object.keys(attrs)
    .sort()
    .map((key) => `${key}=${formatValue(attrs[key] as Value)}`)
    .join("  ");
}

function printWorld(world: World): void {
  const entities = listEntities(world);
  const relations = listRelations(world);
  const grouped = entities.length > 0 && entities.every((entity) => typeof entity.attrs.label === "string" && typeof entity.attrs.order === "number");
  const title = world.name ? `${world.name}  ` : "";
  console.log(`\n${title}第 ${world.tick} 拍开始   ${entities.length} 个实体   ${relations.length} 条关系`);
  if (grouped) {
    const groups = new Map<number, { label: string; scores: number[] }>();
    for (const entity of entities) {
      const order = entity.attrs.order;
      const label = entity.attrs.label;
      if (typeof order !== "number" || typeof label !== "string") continue;
      const group = groups.get(order) ?? { label, scores: [] };
      group.scores.push(typeof entity.attrs.score === "number" ? entity.attrs.score : 0);
      groups.set(order, group);
    }
    for (const order of [...groups.keys()].sort((a, b) => a - b)) {
      const group = groups.get(order);
      if (!group || group.scores.length === 0) continue;
      const mean = group.scores.reduce((sum, score) => sum + score, 0) / group.scores.length;
      console.log(`  ${group.label}  ${group.scores.length} 人  均分 ${mean.toFixed(1)}`);
    }
    return;
  }
  for (const entity of entities) {
    const names = entity.strategies.map((strategy) => strategy.name).join(", ");
    const attrs = formatAttrs(entity.attrs);
    console.log(`  ${entity.id} [${names}]${attrs ? `  ${attrs}` : ""}`);
  }
  if (relations.length > 8) return;
  for (const relation of relations) {
    const attrs = formatAttrs(relation.attrs);
    console.log(`  ${relation.from} → ${relation.to}${attrs ? `  ${attrs}` : ""}`);
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (options.world === "demo") {
    const world = buildDemoWorld();
    const ticks = options.ticks ?? 4;
    console.log(demoIntro);
    printWorld(world);
    for (let i = 0; i < ticks; i += 1) {
      step(world);
      printWorld(world);
    }
    return;
  }
  const params = tftParams(options);
  const world = createTftWorld(params);
  const ticks = options.ticks ?? 12;
  console.log(tftIntro(params));
  let marks: CountMark[] = [];
  const note = () => {
    marks = rememberCounts(marks, world.tick, strategyCounts(world));
  };
  note();
  printWorld(world);
  let stopMessage = "";
  for (let i = 0; i < ticks; i += 1) {
    if (strategyCounts(world).length <= 1) {
      stopMessage = "只剩一种策略，提前结束。";
      break;
    }
    if (sameScoresAtSelection(world, params.every, params.dead ?? 0)) {
      const dead = params.dead ?? 0;
      stopMessage = dead === 0
        ? "所有人分数相同，结果已经固定，提前结束。"
        : `所有人分数的差距不超过最高分的 ${dead}，结果已经固定，提前结束。`;
      break;
    }
    step(world);
    note();
    printWorld(world);
  }
  if (stopMessage) console.log(`\n${stopMessage}`);
  printRanking(marks, params, ticks, world.tick);
}

function strategyCounts(world: World): { order: number; label: string; count: number }[] {
  const groups = new Map<number, { label: string; count: number }>();
  for (const entity of listEntities(world)) {
    const order = entity.attrs.order;
    const label = entity.attrs.label;
    if (typeof order !== "number" || typeof label !== "string") continue;
    const group = groups.get(order) ?? { label, count: 0 };
    group.count += 1;
    groups.set(order, group);
  }
  return [...groups.entries()].map(([order, group]) => ({ order, label: group.label, count: group.count }));
}

function printRanking(marks: CountMark[], params: TftParams, plannedTicks: number, endedAt: number): void {
  const ranked = rankCounts(marks);
  if (ranked.length === 0) return;
  console.log("\n最终人数排名");
  console.log(tftRankingNote(params, plannedTicks, endedAt));
  console.log("人数相同的，更晚变成这个人数的排在上面。");
  ranked.forEach((row, index) => {
    console.log(`  ${index + 1}  ${row.label}  ${row.count} 人  第 ${row.updatedAt} 拍更新到这个人数`);
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
