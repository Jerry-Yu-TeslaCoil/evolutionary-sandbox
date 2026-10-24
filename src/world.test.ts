import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addEntity,
  createWorld,
  listEntities,
  listRelations,
  putRelation,
  step,
  TickConflict,
  type Strategy,
  type WorldRule,
} from "./world.ts";

function entity(world: ReturnType<typeof createWorld>, id: string) {
  return listEntities(world).find((item) => item.id === id);
}

function strategy(name: string, run: Strategy["run"]): Strategy {
  return { name, run };
}

test("同一拍里后执行的策略看不到先写出的值", () => {
  const world = createWorld();
  addEntity(world, {
    id: "a",
    attrs: { x: 0, y: 0 },
    strategies: [
      strategy("write", (ctx) => ctx.self.set("x", 1)),
      strategy("read", (ctx) => ctx.self.set("y", ctx.self.attrs.x)),
    ],
  });
  step(world);
  assert.equal(entity(world, "a")?.attrs.x, 1);
  assert.equal(entity(world, "a")?.attrs.y, 0);
});

test("同一拍对同一个数的修改会加在一起", () => {
  const world = createWorld();
  addEntity(world, { id: "a", strategies: [strategy("hit", (ctx) => ctx.world.entity("c")?.add("hp", -1))] });
  addEntity(world, { id: "b", strategies: [strategy("hit", (ctx) => ctx.world.entity("c")?.add("hp", -1))] });
  addEntity(world, { id: "c", attrs: { hp: 5 }, strategies: [] });
  step(world);
  assert.equal(entity(world, "c")?.attrs.hp, 3);
});

test("覆盖之后再累加", () => {
  const world = createWorld();
  addEntity(world, {
    id: "a",
    attrs: { hp: 1 },
    strategies: [
      strategy("reset", (ctx) => ctx.self.set("hp", 10)),
      strategy("nick", (ctx) => ctx.self.add("hp", -1)),
    ],
  });
  step(world);
  assert.equal(entity(world, "a")?.attrs.hp, 9);
});

test("同一拍把同一个值写成两个不同结果时，整拍不落地", () => {
  const world = createWorld();
  addEntity(world, {
    id: "a",
    attrs: { mood: "calm" },
    strategies: [
      strategy("one", (ctx) => ctx.self.set("mood", "hot")),
      strategy("two", (ctx) => ctx.self.set("mood", "cold")),
    ],
  });
  assert.throws(() => step(world), TickConflict);
  assert.equal(world.tick, 0);
  assert.equal(entity(world, "a")?.attrs.mood, "calm");
});

test("策略抛错时这一拍不落地", () => {
  const world = createWorld();
  addEntity(world, {
    id: "a",
    attrs: { n: 1 },
    strategies: [
      strategy("boom", (ctx) => {
        ctx.self.add("n", 1);
        throw new Error("boom");
      }),
    ],
  });
  assert.throws(() => step(world), /boom/);
  assert.equal(world.tick, 0);
  assert.equal(entity(world, "a")?.attrs.n, 1);
});

test("关系要到下一拍才能被读到", () => {
  const world = createWorld();
  addEntity(world, {
    id: "alice",
    strategies: [strategy("wave", (ctx) => ctx.world.relation("alice", "bob").set("wave", "hi"))],
  });
  addEntity(world, {
    id: "bob",
    attrs: { heard: "" },
    strategies: [
      strategy("listen", (ctx) => {
        const wave = ctx.world.relation("alice", "bob").attrs.wave;
        ctx.self.set("heard", typeof wave === "string" ? wave : "");
      }),
    ],
  });
  step(world);
  assert.equal(entity(world, "bob")?.attrs.heard, "");
  assert.equal(listRelations(world)[0]?.attrs.wave, "hi");
  step(world);
  assert.equal(entity(world, "bob")?.attrs.heard, "hi");
});

test("同一拍追加的文本按实体 id 接上", () => {
  const world = createWorld();
  const mark = (id: string): Strategy =>
    strategy("mark", (ctx) => ctx.world.entity("log")?.append("line", id));
  addEntity(world, { id: "m", strategies: [mark("m")] });
  addEntity(world, { id: "a", strategies: [mark("a")] });
  addEntity(world, { id: "log", attrs: {}, strategies: [] });
  step(world);
  assert.equal(entity(world, "log")?.attrs.line, "a,m");
});

test("实体离场时带走关系", () => {
  const world = createWorld();
  addEntity(world, {
    id: "alice",
    strategies: [
      strategy("leave", (ctx) => {
        ctx.self.remove();
        ctx.world.relation("alice", "bob").set("note", "bye");
      }),
    ],
  });
  addEntity(world, { id: "bob", strategies: [] });
  putRelation(world, "bob", "alice", { note: "stay" });
  step(world);
  assert.equal(entity(world, "alice"), undefined);
  assert.deepEqual(listRelations(world), []);
});

test("指向不存在实体的关系修改会让这一拍失败", () => {
  const world = createWorld();
  addEntity(world, {
    id: "alice",
    strategies: [strategy("miss", (ctx) => ctx.world.relation("alice", "ghost").set("note", "x"))],
  });
  assert.throws(() => step(world), TickConflict);
  assert.equal(world.tick, 0);
});

test("新实体要到下一拍才执行策略", () => {
  const touch: Strategy = strategy("touch", (ctx) => ctx.world.entity("parent")?.add("n", 1));
  const world = createWorld();
  addEntity(world, {
    id: "parent",
    attrs: { n: 0 },
    strategies: [
      strategy("bud", (ctx) => {
        if (ctx.tick !== 0) return;
        ctx.spawn({ id: "child", attrs: { n: 0 }, strategies: [touch] });
      }),
    ],
  });
  step(world);
  assert.equal(entity(world, "child")?.attrs.n, 0);
  assert.equal(entity(world, "parent")?.attrs.n, 0);
  step(world);
  assert.equal(entity(world, "parent")?.attrs.n, 1);
});

test("清空关系时，这一拍结束不留下任何关系", () => {
  const world = createWorld();
  addEntity(world, { id: "a", attrs: { score: 4 } });
  addEntity(world, { id: "b", attrs: { score: 1 } });
  putRelation(world, "a", "b", { lastOpp: "D" });
  const wipe: WorldRule = {
    name: "wipe",
    run(ctx) {
      ctx.world.relation("b", "a").set("lastOpp", "C");
      ctx.clearRelations();
    },
  };
  world.rules = [wipe];
  step(world);
  assert.equal(entity(world, "a")?.attrs.score, 4);
  assert.deepEqual(listRelations(world), []);
});
