export type Value = number | string | boolean | null;
export type Attrs = Record<string, Value>;

export interface Strategy {
  name: string;
  run(ctx: StrategyContext): void;
}

export interface SpawnSpec {
  id?: string;
  attrs?: Attrs;
  strategies?: readonly Strategy[];
}

export interface StrategyContext {
  /** 正在结算的这一拍。0 是第一拍。 */
  tick: number;
  self: EntityView;
  world: WorldView;
  spawn(spec: SpawnSpec): void;
  remove(id: string): void;
}

export interface EntityView {
  readonly id: string;
  readonly attrs: Readonly<Attrs>;
  readonly strategies: readonly Strategy[];
  set(key: string, value: Value): void;
  add(key: string, delta: number): void;
  append(key: string, text: string): void;
  remove(): void;
}

export interface RelationView {
  readonly from: string;
  readonly to: string;
  readonly attrs: Readonly<Attrs>;
  set(key: string, value: Value): void;
  add(key: string, delta: number): void;
  append(key: string, text: string): void;
}

export interface WorldView {
  readonly tick: number;
  entity(id: string): EntityView | undefined;
  entities(): EntityView[];
  /** (from, to) 与 (to, from) 是两格。没有记录时属性为空，写入会在落地时建格。 */
  relation(from: string, to: string): RelationView;
  relations(): RelationView[];
}

export interface WorldRuleContext {
  tick: number;
  seed: number;
  world: WorldView;
  spawn(spec: SpawnSpec): void;
  remove(id: string): void;
  /** 这一拍结束时丢掉全部关系。同一拍里新写的关系也一起丢掉。 */
  clearRelations(): void;
}

/** 一拍执行一次，看整份冻结的世界。和实体策略一样，写入要等这一拍结束才落地。 */
export interface WorldRule {
  name: string;
  run(ctx: WorldRuleContext): void;
}

export interface EntityState {
  id: string;
  attrs: Attrs;
  strategies: Strategy[];
}

export interface RelationState {
  from: string;
  to: string;
  attrs: Attrs;
}

export interface World {
  name: string;
  tick: number;
  seed: number;
  nextSerial: number;
  entities: Map<string, EntityState>;
  relations: Map<string, Map<string, Attrs>>;
  rules: WorldRule[];
}

export class TickConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TickConflict";
  }
}

interface Writer {
  entityId: string;
  strategy: string;
  index: number;
  order: number;
}

type Target =
  | { kind: "entity"; id: string }
  | { kind: "relation"; from: string; to: string };

interface SetPatch {
  op: "set";
  target: Target;
  key: string;
  value: Value;
  writer: Writer;
}

interface AddPatch {
  op: "add";
  target: Target;
  key: string;
  delta: number;
  writer: Writer;
}

interface AppendPatch {
  op: "append";
  target: Target;
  key: string;
  text: string;
  writer: Writer;
}

interface RemovePatch {
  op: "remove";
  id: string;
  writer: Writer;
}

interface SpawnPatch {
  op: "spawn";
  id?: string;
  attrs: Attrs;
  strategies: Strategy[];
  writer: Writer;
}

interface ClearRelationsPatch {
  op: "clearRelations";
  writer: Writer;
}

type Patch = SetPatch | AddPatch | AppendPatch | RemovePatch | SpawnPatch | ClearRelationsPatch;

interface Bucket {
  sets: Array<{ value: Value; writer: Writer }>;
  adds: Array<{ delta: number; writer: Writer }>;
  appends: Array<{ text: string; writer: Writer }>;
}

const EMPTY_ATTRS: Readonly<Attrs> = Object.freeze({});

export function createWorld(): World {
  return {
    name: "",
    tick: 0,
    seed: 1,
    nextSerial: 1,
    entities: new Map(),
    relations: new Map(),
    rules: [],
  };
}

export function addEntity(
  world: World,
  spec: { id: string; attrs?: Attrs; strategies?: readonly Strategy[] },
): void {
  validateId(spec.id);
  if (world.entities.has(spec.id)) throw new Error(`实体 ${spec.id} 已存在`);
  for (const strategy of spec.strategies ?? []) validateStrategy(strategy);
  world.entities.set(spec.id, {
    id: spec.id,
    attrs: copyAttrs(spec.attrs),
    strategies: [...(spec.strategies ?? [])],
  });
}

export function putRelation(world: World, from: string, to: string, attrs: Attrs): void {
  validateId(from);
  validateId(to);
  if (!world.entities.has(from) || !world.entities.has(to)) {
    throw new Error("关系的两端都必须是当前世界里的实体");
  }
  writeRelation(world.relations, from, to, copyAttrs(attrs));
}

export function listEntities(world: World): EntityState[] {
  return [...world.entities.values()]
    .sort((a, b) => compareText(a.id, b.id))
    .map((entity) => ({
      id: entity.id,
      attrs: { ...entity.attrs },
      strategies: [...entity.strategies],
    }));
}

export function listRelations(world: World): RelationState[] {
  const rows: RelationState[] = [];
  for (const [from, inner] of world.relations) {
    for (const [to, attrs] of inner) rows.push({ from, to, attrs: { ...attrs } });
  }
  rows.sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  return rows;
}

/** 冻结当前世界，执行每个实体的每个策略和每条世界规则，再一次性落地。出错时世界保持原样。 */
export function step(world: World): void {
  const snapshot = snapshotWorld(world);
  const patches: Patch[] = [];
  let emission = 0;
  const nextOrder = (): number => {
    emission += 1;
    return emission;
  };
  const ids = [...snapshot.entities.keys()].sort(compareText);
  for (const id of ids) {
    const entity = snapshot.entities.get(id);
    if (!entity) continue;
    const strategies = [...entity.strategies];
    for (let index = 0; index < strategies.length; index += 1) {
      const strategy = strategies[index];
      if (!strategy) continue;
      validateNamed(strategy);
      const writerBase = { entityId: id, strategy: strategy.name, index };
      const ctx = createContext(snapshot, entity, patches, writerBase, nextOrder);
      strategy.run(ctx);
    }
  }
  const rules = [...world.rules];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule) continue;
    validateNamed(rule);
    const session = createSession(snapshot, patches, { entityId: world.name || "world", strategy: rule.name, index }, nextOrder);
    rule.run({
      tick: snapshot.tick,
      seed: world.seed,
      world: session.world,
      spawn: session.spawn,
      remove: session.remove,
      clearRelations: session.clearRelations,
    });
  }
  const next = applyPatches(snapshot, patches);
  world.tick = next.tick;
  world.nextSerial = next.nextSerial;
  world.entities = next.entities;
  world.relations = next.relations;
}

function createContext(
  snapshot: World,
  self: EntityState,
  patches: Patch[],
  writerBase: Omit<Writer, "order">,
  nextOrder: () => number,
): StrategyContext {
  const session = createSession(snapshot, patches, writerBase, nextOrder);
  return {
    tick: snapshot.tick,
    self: session.viewEntity(self),
    world: session.world,
    spawn: session.spawn,
    remove: session.remove,
  };
}

function createSession(
  snapshot: World,
  patches: Patch[],
  writerBase: Omit<Writer, "order">,
  nextOrder: () => number,
): {
  world: WorldView;
  spawn: (spec: SpawnSpec) => void;
  remove: (id: string) => void;
  viewEntity: (entity: EntityState) => EntityView;
  clearRelations: () => void;
} {
  const entityViews = new Map<string, EntityView>();
  const relationViews = new Map<string, RelationView>();
  const writer = (): Writer => ({ ...writerBase, order: nextOrder() });

  const viewEntity = (entity: EntityState): EntityView => {
    const cached = entityViews.get(entity.id);
    if (cached) return cached;
    const view: EntityView = {
      id: entity.id,
      attrs: freezeAttrs(entity.attrs),
      strategies: Object.freeze([...entity.strategies]),
      set: (key, value) => pushSet(patches, { kind: "entity", id: entity.id }, key, value, writer()),
      add: (key, delta) => pushAdd(patches, { kind: "entity", id: entity.id }, key, delta, writer()),
      append: (key, text) => pushAppend(patches, { kind: "entity", id: entity.id }, key, text, writer()),
      remove: () => patches.push({ op: "remove", id: entity.id, writer: writer() }),
    };
    entityViews.set(entity.id, view);
    return view;
  };

  const relationView = (from: string, to: string): RelationView => {
    validateId(from);
    validateId(to);
    const cacheKey = `${from}\0${to}`;
    const cached = relationViews.get(cacheKey);
    if (cached) return cached;
    const attrs = snapshot.relations.get(from)?.get(to) ?? EMPTY_ATTRS;
    const view: RelationView = {
      from,
      to,
      attrs: attrs === EMPTY_ATTRS ? EMPTY_ATTRS : freezeAttrs(attrs),
      set: (key, value) => pushSet(patches, { kind: "relation", from, to }, key, value, writer()),
      add: (key, delta) => pushAdd(patches, { kind: "relation", from, to }, key, delta, writer()),
      append: (key, text) => pushAppend(patches, { kind: "relation", from, to }, key, text, writer()),
    };
    relationViews.set(cacheKey, view);
    return view;
  };

  const world: WorldView = {
    tick: snapshot.tick,
    entity: (id) => {
      const entity = snapshot.entities.get(id);
      return entity ? viewEntity(entity) : undefined;
    },
    entities: () => [...snapshot.entities.values()].sort((a, b) => compareText(a.id, b.id)).map(viewEntity),
    relation: relationView,
    relations: () => {
      const rows: RelationView[] = [];
      for (const [from, inner] of snapshot.relations) {
        for (const to of inner.keys()) rows.push(relationView(from, to));
      }
      rows.sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
      return rows;
    },
  };

  return {
    world,
    viewEntity,
    spawn: (spec) => {
      if (spec.id !== undefined) validateId(spec.id);
      for (const strategy of spec.strategies ?? []) validateStrategy(strategy);
      patches.push({
        op: "spawn",
        id: spec.id,
        attrs: copyAttrs(spec.attrs),
        strategies: [...(spec.strategies ?? [])],
        writer: writer(),
      });
    },
    remove: (id) => {
      validateId(id);
      patches.push({ op: "remove", id, writer: writer() });
    },
    clearRelations: () => {
      patches.push({ op: "clearRelations", writer: writer() });
    },
  };
}

function applyPatches(snapshot: World, patches: Patch[]): Pick<World, "tick" | "nextSerial" | "entities" | "relations"> {
  const removals = new Set<string>();
  const spawns: SpawnPatch[] = [];
  const buckets = new Map<string, { target: Target; key: string; bucket: Bucket }>();
  let clearRelations = false;

  for (const patch of patches) {
    if (patch.op === "remove") {
      removals.add(patch.id);
      continue;
    }
    if (patch.op === "spawn") {
      spawns.push(patch);
      continue;
    }
    if (patch.op === "clearRelations") {
      clearRelations = true;
      continue;
    }
    const slot = slotOf(patch.target, patch.key);
    let grouped = buckets.get(slot.key);
    if (!grouped) {
      grouped = { target: patch.target, key: patch.key, bucket: { sets: [], adds: [], appends: [] } };
      buckets.set(slot.key, grouped);
    }
    if (patch.op === "set") grouped.bucket.sets.push({ value: patch.value, writer: patch.writer });
    else if (patch.op === "add") grouped.bucket.adds.push({ delta: patch.delta, writer: patch.writer });
    else grouped.bucket.appends.push({ text: patch.text, writer: patch.writer });
  }

  const explicitIds = spawns.flatMap((spawn) => (spawn.id === undefined ? [] : [spawn.id]));
  const duplicate = explicitIds.find((id, index) => explicitIds.indexOf(id) !== index);
  if (duplicate) throw new TickConflict(`同一拍内多次生成实体 ${duplicate}`);

  for (const id of removals) {
    const spawned = explicitIds.includes(id);
    if (!snapshot.entities.has(id) && !spawned) {
      throw new TickConflict(`无法移除不存在的实体 ${id}`);
    }
  }

  const keptSpawns = spawns.filter((spawn) => {
    if (spawn.id !== undefined && removals.has(spawn.id) && !snapshot.entities.has(spawn.id)) return false;
    return true;
  });
  keptSpawns.sort((a, b) => compareWriter(a.writer, b.writer));

  const finalEntities = new Map<string, EntityState>();
  for (const [id, entity] of snapshot.entities) {
    if (removals.has(id)) continue;
    finalEntities.set(id, {
      id,
      attrs: { ...entity.attrs },
      strategies: [...entity.strategies],
    });
  }

  let nextSerial = snapshot.nextSerial;
  const used = new Set(finalEntities.keys());
  for (const spawn of keptSpawns) {
    if (spawn.id !== undefined && snapshot.entities.has(spawn.id) && !removals.has(spawn.id)) {
      throw new TickConflict(`实体 ${spawn.id} 仍在场，不能在同一拍生成同名实体`);
    }
    let id = spawn.id;
    if (id === undefined) {
      while (used.has(`e${nextSerial}`) || snapshot.entities.has(`e${nextSerial}`)) nextSerial += 1;
      id = `e${nextSerial}`;
      nextSerial += 1;
    }
    if (used.has(id)) throw new TickConflict(`同一拍内实体 ${id} 被重复生成`);
    used.add(id);
    finalEntities.set(id, { id, attrs: { ...spawn.attrs }, strategies: [...spawn.strategies] });
  }

  const classify = (id: string): "live" | "gone" | "missing" => {
    if (finalEntities.has(id)) return "live";
    if (removals.has(id)) return "gone";
    return "missing";
  };

  for (const grouped of buckets.values()) {
    if (grouped.target.kind !== "entity") continue;
    const presence = classify(grouped.target.id);
    if (presence === "missing") {
      throw new TickConflict(`无法修改不存在的实体 ${grouped.target.id} 的 ${grouped.key}`);
    }
    if (presence === "gone") continue;
    const entity = finalEntities.get(grouped.target.id);
    if (!entity) continue;
    entity.attrs[grouped.key] = mergeValue(entity.attrs[grouped.key], grouped.bucket, describeEntity(grouped.target.id, grouped.key));
  }

  const finalRelations: World["relations"] = new Map();
  for (const [from, inner] of snapshot.relations) {
    if (classify(from) !== "live") continue;
    for (const [to, attrs] of inner) {
      if (classify(to) !== "live") continue;
      writeRelation(finalRelations, from, to, { ...attrs });
    }
  }

  for (const grouped of buckets.values()) {
    if (grouped.target.kind !== "relation") continue;
    const { from, to } = grouped.target;
    const ends = [classify(from), classify(to)];
    if (ends.includes("missing")) {
      throw new TickConflict(`无法修改关系 ${from} → ${to}：一端不是这一拍里的实体`);
    }
    if (ends.includes("gone")) continue;
    const current = finalRelations.get(from)?.get(to)?.[grouped.key];
    const value = mergeValue(current, grouped.bucket, `关系 ${from} → ${to} 的 ${grouped.key}`);
    const attrs = finalRelations.get(from)?.get(to) ?? {};
    attrs[grouped.key] = value;
    writeRelation(finalRelations, from, to, attrs);
  }
  if (clearRelations) finalRelations.clear();

  return {
    tick: snapshot.tick + 1,
    nextSerial,
    entities: finalEntities,
    relations: finalRelations,
  };
}

function mergeValue(current: Value | undefined, bucket: Bucket, label: string): Value {
  const distinct = new Map<string, { value: Value; writers: Writer[] }>();
  for (const entry of bucket.sets) {
    const stamp = valueStamp(entry.value);
    const found = distinct.get(stamp);
    if (found) found.writers.push(entry.writer);
    else distinct.set(stamp, { value: entry.value, writers: [entry.writer] });
  }
  if (distinct.size > 1) {
    const detail = [...distinct.values()]
      .map((entry) => `${entry.writers.map(writerLabel).join("、")} 写成 ${formatValue(entry.value)}`)
      .join("；");
    throw new TickConflict(`${label} 在同一拍被写成了不同的值：${detail}`);
  }

  let base: Value | undefined = distinct.size === 1 ? [...distinct.values()][0]?.value : current;
  if (bucket.adds.length > 0) {
    const delta = bucket.adds.reduce((sum, entry) => sum + entry.delta, 0);
    const numeric = base === undefined ? 0 : base;
    if (typeof numeric !== "number") {
      throw new TickConflict(`${label} 不是数值，不能累加`);
    }
    base = numeric + delta;
  }
  if (bucket.appends.length > 0) {
    const texts = [...bucket.appends].sort((a, b) => compareWriter(a.writer, b.writer)).map((entry) => entry.text);
    const joined = texts.join(",");
    if (base === undefined || base === "") base = joined;
    else if (typeof base === "string") base = `${base},${joined}`;
    else throw new TickConflict(`${label} 不是文本，不能追加`);
  }
  if (base === undefined) throw new TickConflict(`${label} 没有可落地的值`);
  return base;
}

function snapshotWorld(world: World): World {
  const entities = new Map<string, EntityState>();
  for (const [id, entity] of world.entities) {
    entities.set(id, {
      id,
      attrs: { ...entity.attrs },
      strategies: [...entity.strategies],
    });
  }
  const relations: World["relations"] = new Map();
  for (const [from, inner] of world.relations) {
    for (const [to, attrs] of inner) writeRelation(relations, from, to, { ...attrs });
  }
  return {
    name: world.name,
    tick: world.tick,
    seed: world.seed,
    nextSerial: world.nextSerial,
    entities,
    relations,
    rules: [...world.rules],
  };
}

function pushSet(patches: Patch[], target: Target, key: string, value: Value, writer: Writer): void {
  validateKey(key);
  validateValue(value);
  patches.push({ op: "set", target, key, value, writer });
}

function pushAdd(patches: Patch[], target: Target, key: string, delta: number, writer: Writer): void {
  validateKey(key);
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    throw new Error(`累加量必须是有限数值：${String(delta)}`);
  }
  patches.push({ op: "add", target, key, delta, writer });
}

function pushAppend(patches: Patch[], target: Target, key: string, text: string, writer: Writer): void {
  validateKey(key);
  if (typeof text !== "string" || text.length === 0 || text.includes(",") || text.includes("\n") || text.includes("\0")) {
    throw new Error(`追加的文本要是不含逗号或换行的非空字符串：${JSON.stringify(text)}`);
  }
  patches.push({ op: "append", target, key, text, writer });
}

function slotOf(target: Target, key: string): { key: string } {
  if (target.kind === "entity") return { key: `e\0${target.id}\0${key}` };
  return { key: `r\0${target.from}\0${target.to}\0${key}` };
}

function writeRelation(relations: World["relations"], from: string, to: string, attrs: Attrs): void {
  let inner = relations.get(from);
  if (!inner) {
    inner = new Map();
    relations.set(from, inner);
  }
  inner.set(to, attrs);
}

function copyAttrs(attrs: Attrs | undefined): Attrs {
  const out: Attrs = {};
  if (!attrs) return out;
  for (const [key, value] of Object.entries(attrs)) {
    validateKey(key);
    validateValue(value);
    out[key] = value;
  }
  return out;
}

function freezeAttrs(attrs: Attrs): Readonly<Attrs> {
  return Object.freeze({ ...attrs });
}

function validateNamed(value: { name: string; run: unknown }): void {
  if (!value || typeof value.name !== "string" || value.name.length === 0 || typeof value.run !== "function") {
    throw new Error("策略需要非空名称和 run 函数");
  }
}

function validateStrategy(strategy: { name: string; run: unknown }): void {
  validateNamed(strategy);
}

function validateId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || /[\0\n\r]/.test(id)) {
    throw new Error(`非法的实体 id：${JSON.stringify(id)}`);
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || /[\0\n\r]/.test(key)) {
    throw new Error(`非法的属性名：${JSON.stringify(key)}`);
  }
}

function validateValue(value: Value): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("数值属性必须是有限数");
    return;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return;
  throw new Error("属性只能是数值、字符串、布尔或 null");
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareWriter(a: Writer, b: Writer): number {
  return compareText(a.entityId, b.entityId) || a.index - b.index || a.order - b.order;
}

function writerLabel(writer: Writer): string {
  return `${writer.entityId}/${writer.strategy}`;
}

function describeEntity(id: string, key: string): string {
  return `实体 ${id} 的 ${key}`;
}

function valueStamp(value: Value): string {
  return `${typeof value}:${String(value)}`;
}

function formatValue(value: Value): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
