import { listEntities, listRelations, step, type Value, type World } from "./world.ts";
import { createTftWorld, defaultTftParams, formatPopulationSpacing, populationSpacing, rankCounts, rememberCounts, sameScoresAtSelection, tftCategories, tftIntro, tftRankingNote, type CountMark, type TftParams } from "./tft.ts";

interface Options {
  ticks?: number;
  every?: number;
  eliminate?: number;
  seed?: number;
  count?: number;
  ratio?: number;
  flip?: number;
  dead?: number;
  approach?: number;
  coexist?: number;
  follow?: number;
  flee?: number;
  near?: number;
  stray?: number;
  window?: number;
  strikes?: number;
  overrides: { key: string; count: number }[];
}

function parseOptions(argv: string[]): Options {
  const options: Options = { overrides: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log([
        "用法:",
        "  npm start -- --ticks 12",
        "  npm start -- --every 5 --eliminate 8 --count 3 --seed 1",
        "  npm start -- --n 1=5 --n tft=2",
        "  npm start -- --ratio 0.3",
        "  npm start -- --flip 0.05",
        "  npm start -- --dead 0.05",
        "  npm start -- --approach 0.2 --coexist 0 --follow 0.15 --flee 0.45",
        "  npm start -- --near 1/3 --stray 0",
        "  npm start -- --window 5 --strikes 3",
        "",
        "--ratio 是同质化的判断比例，取 0 到 1，也可以写成分数。合作占比达到它才合作。越低越乐观，越高越悲观。默认 0.5。",
        "--flip 是每个出牌决定被翻转的概率，取 0 到 1，也可以写成分数。默认 0。",
        "--dead 是分数死区，取 0 到 1，也可以写成分数。繁衍那一拍最高分减最低分不超过最高分的这个比例，就当作分数相同并提前结束。默认 0。",
        "--approach、--coexist、--follow、--flee 是位置系数，可以是负数。正数沿原来的方向走，负数反过来。默认靠近 0.2、共存 0、跟随 0.15、远离 0.45。",
        "--near 是每人挑选的最近对手占其他人的比例，取 0 到 1，也可以写成分数。名额向下取整。默认 1/3。",
        "--stray 是意外相遇：从最近名额剩下的对手里再随机抽的比例，取 0 到 1，也可以写成分数。名额向下取整，抽到的人不管远近。只要有一方抽到对方，两人就打。默认 0。",
        "--window 是爆发者回看的最近次数，--strikes 是其中要达到的背叛次数。都是正整数，背叛次数不能大于回看次数。默认 5 和 3。",
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
    if (arg === "--approach" || arg?.startsWith("--approach=")) {
      options.approach = numberArg(read("--approach"), "--approach");
      continue;
    }
    if (arg === "--coexist" || arg?.startsWith("--coexist=")) {
      options.coexist = numberArg(read("--coexist"), "--coexist");
      continue;
    }
    if (arg === "--follow" || arg?.startsWith("--follow=")) {
      options.follow = numberArg(read("--follow"), "--follow");
      continue;
    }
    if (arg === "--flee" || arg?.startsWith("--flee=")) {
      options.flee = numberArg(read("--flee"), "--flee");
      continue;
    }
    if (arg === "--near" || arg?.startsWith("--near=")) {
      options.near = unitArg(read("--near"), "--near");
      continue;
    }
    if (arg === "--stray" || arg?.startsWith("--stray=")) {
      options.stray = unitArg(read("--stray"), "--stray");
      continue;
    }
    if (arg === "--window" || arg?.startsWith("--window=")) {
      options.window = positiveInt(read("--window"), "--window");
      continue;
    }
    if (arg === "--strikes" || arg?.startsWith("--strikes=")) {
      options.strikes = positiveInt(read("--strikes"), "--strikes");
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

function positiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 要是正整数`);
  return value;
}

function numberArg(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} 要是数字`);
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
    approach: options.approach ?? defaultTftParams.approach,
    coexist: options.coexist ?? defaultTftParams.coexist,
    follow: options.follow ?? defaultTftParams.follow,
    flee: options.flee ?? defaultTftParams.flee,
    near: options.near ?? defaultTftParams.near,
    stray: options.stray ?? defaultTftParams.stray,
    window: options.window ?? defaultTftParams.window,
    strikes: options.strikes ?? defaultTftParams.strikes,
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
  printRanking(world, marks, params, ticks, world.tick);
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

function printRanking(world: World, marks: CountMark[], params: TftParams, plannedTicks: number, endedAt: number): void {
  const ranked = rankCounts(marks);
  if (ranked.length === 0) return;
  console.log("\n最终人数排名");
  console.log(tftRankingNote(params, plannedTicks, endedAt));
  console.log("人数相同的，更晚变成这个人数的排在上面。");
  ranked.forEach((row, index) => {
    console.log(`  ${index + 1}  ${row.label}  ${row.count} 人  第 ${row.updatedAt} 拍更新到这个人数`);
  });
  console.log(`\n${formatPopulationSpacing(populationSpacing(listEntities(world)))}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
