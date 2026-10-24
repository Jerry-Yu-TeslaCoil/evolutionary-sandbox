import assert from "node:assert/strict";
import { test } from "node:test";
import { createTftWorld, defaultTftParams, flipMove, moveOf, rankCounts, rememberCounts, sameScoresAtSelection, spreadWeights, tftRankingNote } from "./tft.ts";
import { listEntities, listRelations, step, type World } from "./world.ts";

test("常见出法按各自的规则决定下一手", () => {
  assert.equal(moveOf("tft", {}), "C");
  assert.equal(moveOf("tft", { t: 1, lastOpp: "D" }), "D");
  assert.equal(moveOf("suspiciousTft", {}), "D");
  assert.equal(moveOf("suspiciousTft", { t: 1, lastOpp: "C" }), "C");
  assert.equal(moveOf("titForTwoTats", { lastOpp: "D", prevOpp: "C" }), "C");
  assert.equal(moveOf("titForTwoTats", { lastOpp: "D", prevOpp: "D" }), "D");
  assert.equal(moveOf("alternator", { t: 0 }), "C");
  assert.equal(moveOf("alternator", { t: 1 }), "D");
  assert.equal(moveOf("pavlov", {}), "C");
  assert.equal(moveOf("pavlov", { t: 1, lastMine: "C", lastOpp: "D" }), "D");
  assert.equal(moveOf("pavlov", { t: 1, lastMine: "D", lastOpp: "C" }), "D");
  assert.equal(moveOf("grudger", { oppD: 0 }), "C");
  assert.equal(moveOf("grudger", { oppD: 1 }), "D");
  assert.equal(moveOf("softMajority", { oppC: 1, oppD: 1 }), "C");
  assert.equal(moveOf("hardMajority", { oppC: 1, oppD: 1 }), "D");
  assert.equal(moveOf("hardMajority", {}), "D");
  assert.equal(moveOf("detective", { t: 1 }), "D");
  assert.equal(moveOf("detective", { t: 4, oppD: 0, lastOpp: "C" }), "D");
  assert.equal(moveOf("detective", { t: 4, oppD: 1, lastOpp: "C" }), "C");
  assert.equal(moveOf("prober", { t: 0 }), "D");
  assert.equal(moveOf("prober", { t: 3, opp1: "C", opp2: "C", lastOpp: "C" }), "D");
  assert.equal(moveOf("prober", { t: 3, opp1: "D", opp2: "C", lastOpp: "C" }), "C");
  assert.equal(moveOf("alwaysCooperate", {}), "C");
  assert.equal(moveOf("alwaysDefect", {}), "D");
  assert.equal(moveOf("random", {}, 0.1), "C");
  assert.equal(moveOf("random", {}, 0.9), "D");
  assert.equal(moveOf("homogenized", {}), "C");
  assert.equal(moveOf("homogenized", { worldC: 2, worldD: 2 }), "C");
  assert.equal(moveOf("homogenized", { worldC: 3, worldD: 1 }), "C");
  assert.equal(moveOf("homogenized", { worldC: 1, worldD: 2 }), "D");
  assert.equal(moveOf("burster", {}), "C");
  assert.equal(moveOf("burster", { recent: "DD" }), "C");
  assert.equal(moveOf("burster", { recent: "DDCCC" }), "C");
  assert.equal(moveOf("burster", { recent: "DDD" }), "D");
  assert.equal(moveOf("burster", { recent: "DCDCD" }), "D");
  assert.equal(moveOf("burster", { burst: 1, recent: "CCCCC" }), "D");
  assert.equal(moveOf("forgivingTft", {}), "C");
  assert.equal(moveOf("forgivingTft", { t: 1, lastOpp: "C" }), "C");
  assert.equal(moveOf("forgivingTft", { t: 1, lastOpp: "D" }, 0.2), "C");
  assert.equal(moveOf("forgivingTft", { t: 1, lastOpp: "D" }, 1 / 3), "D");
  assert.equal(moveOf("forgivingTft", { t: 1, lastOpp: "D" }, 0.9), "D");
});

test("会原谅的以牙还牙照抄上一手，被背叛时有时仍合作", () => {
  const noisy = createTftWorld({
    counts: { forgivingTft: 1, alwaysDefect: 1 },
    every: 30,
    eliminate: 1,
    seed: 1,
  });
  const moves: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    step(noisy);
    const move = played(noisy, "forgivingTft#1", "alwaysDefect#1");
    if (move) moves.push(move);
  }
  assert.equal(moves[0], "C");
  assert.equal(moves.includes("C"), true);
  assert.equal(moves.slice(1).includes("D"), true);

  const calm = createTftWorld({
    counts: { forgivingTft: 1, alwaysCooperate: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
  });
  step(calm);
  step(calm);
  step(calm);
  assert.equal(played(calm, "forgivingTft#1", "alwaysCooperate#1"), "C");
});

test("同质化把上一拍所有人的对待加总，开局和平局都合作", () => {
  const tied = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
  });
  step(tied);
  assert.equal(played(tied, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(tied, "homogenized#1", "alwaysDefect#1"), "C");
  step(tied);
  assert.equal(played(tied, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(tied, "homogenized#1", "alwaysDefect#1"), "C");

  const hostile = createTftWorld({
    counts: { homogenized: 1, alwaysDefect: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
  });
  step(hostile);
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#1"), "C");
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#2"), "C");
  step(hostile);
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#1"), "D");
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#2"), "D");
});

test("同质化的判断比例可以改成更乐观或更悲观", () => {
  assert.equal(moveOf("homogenized", { worldC: 1, worldD: 1, ratio: 0.7 }), "D");
  assert.equal(moveOf("homogenized", { worldC: 1, worldD: 2, ratio: 0.3 }), "C");
  assert.equal(moveOf("homogenized", { ratio: 1 }), "C");

  const pessimistic = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
    ratio: 0.7,
  });
  step(pessimistic);
  step(pessimistic);
  assert.equal(played(pessimistic, "homogenized#1", "alwaysCooperate#1"), "D");
  assert.equal(played(pessimistic, "homogenized#1", "alwaysDefect#1"), "D");

  const optimistic = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    ratio: 1 / 3,
  });
  step(optimistic);
  step(optimistic);
  assert.equal(played(optimistic, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(optimistic, "homogenized#1", "alwaysDefect#1"), "C");
  assert.equal(played(optimistic, "homogenized#1", "alwaysDefect#2"), "C");
});

test("爆发者对同一个人最近 5 次里被背叛达到 3 次后永远背叛", () => {
  const world = createTftWorld({
    counts: { burster: 1, alwaysDefect: 1, alwaysCooperate: 1 },
    every: 20,
    eliminate: 1,
    seed: 1,
  });
  step(world);
  step(world);
  step(world);
  assert.equal(played(world, "burster#1", "alwaysDefect#1"), "C");
  assert.equal(played(world, "burster#1", "alwaysCooperate#1"), "C");
  step(world);
  assert.equal(played(world, "burster#1", "alwaysDefect#1"), "D");
  assert.equal(played(world, "burster#1", "alwaysCooperate#1"), "C");

  const opponent = world.entities.get("alwaysDefect#1");
  if (!opponent) throw new Error("缺少永远背叛");
  opponent.attrs.kind = "alwaysCooperate";
  step(world);
  step(world);
  step(world);
  step(world);
  step(world);
  assert.equal(played(world, "burster#1", "alwaysDefect#1"), "D");
  assert.equal(played(world, "burster#1", "alwaysCooperate#1"), "C");
});

test("同人数时，更晚变成这个人数的排在上面", () => {
  let marks = rememberCounts([], 0, [
    { order: 0, label: "以牙还牙", count: 2 },
    { order: 12, label: "永远背叛", count: 2 },
    { order: 5, label: "永远合作", count: 2 },
  ]);
  marks = rememberCounts(marks, 6, [
    { order: 0, label: "以牙还牙", count: 2 },
    { order: 12, label: "永远背叛", count: 4 },
  ]);
  marks = rememberCounts(marks, 11, [
    { order: 0, label: "以牙还牙", count: 4 },
    { order: 12, label: "永远背叛", count: 4 },
  ]);
  assert.deepEqual(
    rankCounts(marks).map((row) => [row.label, row.count, row.updatedAt]),
    [
      ["以牙还牙", 4, 11],
      ["永远背叛", 4, 6],
      ["永远合作", 0, 6],
    ],
  );
});

test("抽亲代先扣掉共同分数，剩下的分才是权重", () => {
  assert.deepEqual(spreadWeights([270, 280, 310]), [1, 11, 41]);
  assert.deepEqual(spreadWeights([5, 5, 5]), [1, 1, 1]);
});

test("结论排名写上这次运行的参数", () => {
  const mixed = tftRankingNote(
    {
      counts: { tft: 2, alwaysDefect: 2 },
      every: 5,
      eliminate: 1,
      seed: 3,
      ratio: 0.3,
      flip: 0.05,
      dead: 0.05,
    },
    30,
    10,
  );
  assert.match(mixed, /以牙还牙 2 人/);
  assert.match(mixed, /永远背叛 2 人/);
  assert.match(mixed, /没写出的类别是 0 人/);
  assert.match(mixed, /每 5 拍繁衍一次，淘汰当时得分最低的 1 人/);
  assert.match(mixed, /种子 3/);
  assert.match(mixed, /判断比例是 0\.3/);
  assert.match(mixed, /0\.05 的概率/);
  assert.match(mixed, /分数死区是最高分的 0\.05/);
  assert.match(mixed, /计划跑 30 拍，排名取第 10 拍开始时的人数/);

  const even = tftRankingNote(defaultTftParams, 12, 12);
  assert.match(even, /每类 3 人/);
  assert.match(even, /判断比例是 0\.5/);
  assert.match(even, /0 的概率/);
  assert.match(even, /分数死区是最高分的 0/);
});

test("每个出牌决定按给定概率翻转，记下来的是实际打出的那一手", () => {
  assert.equal(flipMove("C", 0.04, 0.05), "D");
  assert.equal(flipMove("D", 0.05, 0.05), "D");
  assert.equal(flipMove("C", 0.2, 0), "C");

  const flipped = createTftWorld({
    counts: { alwaysCooperate: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    flip: 1,
  });
  step(flipped);
  assert.equal(played(flipped, "alwaysCooperate#1", "alwaysCooperate#2"), "D");
  assert.equal(played(flipped, "alwaysCooperate#2", "alwaysCooperate#1"), "D");
  assert.equal(
    listEntities(flipped).every((entity) => entity.attrs.score === 1),
    true,
  );

  const steady = createTftWorld({
    counts: { tft: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
    flip: 0,
  });
  step(steady);
  const scores = Object.fromEntries(listEntities(steady).map((entity) => [entity.attrs.kind, entity.attrs.score]));
  assert.deepEqual(scores, { tft: 0, alwaysDefect: 5 });
});

test("以牙还牙第一次被背叛，下一拍才还手", () => {
  const world = createTftWorld({
    counts: { tft: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
  });
  step(world);
  const afterFirst = Object.fromEntries(listEntities(world).map((entity) => [entity.attrs.kind, entity.attrs.score]));
  assert.deepEqual(afterFirst, { tft: 0, alwaysDefect: 5 });
  step(world);
  const afterSecond = Object.fromEntries(listEntities(world).map((entity) => [entity.attrs.kind, entity.attrs.score]));
  assert.deepEqual(afterSecond, { tft: 1, alwaysDefect: 6 });
});

test("一整轮打完后所有人分数相同，繁衍拍就判定为固定", () => {
  const tied = createTftWorld({
    counts: { tft: 2, alwaysCooperate: 2 },
    every: 2,
    eliminate: 1,
    seed: 1,
  });
  step(tied);
  assert.equal(sameScoresAtSelection(tied, 2), false);
  step(tied);
  assert.equal(tied.tick, 2);
  assert.equal(sameScoresAtSelection(tied, 2), true);
  assert.equal(new Set(listEntities(tied).map((entity) => entity.attrs.score)).size, 1);

  const split = createTftWorld({
    counts: { tft: 1, alwaysDefect: 1 },
    every: 2,
    eliminate: 1,
    seed: 1,
  });
  step(split);
  step(split);
  assert.equal(sameScoresAtSelection(split, 2), false);

  const person = tied.entities.get("tft#1");
  if (!person || typeof person.attrs.score !== "number") throw new Error("缺少以牙还牙");
  const before = person.attrs.score;
  person.attrs.score += 4;
  const high = person.attrs.score;
  assert.equal(sameScoresAtSelection(tied, 2, 0), false);
  assert.equal(sameScoresAtSelection(tied, 2, (high - before) / high - 0.01), false);
  assert.equal(sameScoresAtSelection(tied, 2, (high - before) / high), true);
});

test("繁殖拍不对局，下一拍只留下纯策略，关系和得分都清空", () => {
  const world = createTftWorld({
    counts: { alwaysCooperate: 2, alwaysDefect: 2 },
    every: 1,
    eliminate: 2,
    seed: 1,
  });
  step(world);
  const before = listEntities(world).map((entity) => [entity.id, entity.attrs.kind, entity.attrs.score]);
  assert.deepEqual(before, [
    ["alwaysCooperate#1", "alwaysCooperate", 3],
    ["alwaysCooperate#2", "alwaysCooperate", 3],
    ["alwaysDefect#1", "alwaysDefect", 11],
    ["alwaysDefect#2", "alwaysDefect", 11],
  ]);
  step(world);
  const after = listEntities(world);
  assert.equal(after.length, 4);
  assert.equal(after.every((entity) => entity.attrs.kind === "alwaysDefect" && entity.attrs.score === 0), true);
  assert.equal(after.some((entity) => entity.id === "alwaysDefect#1"), true);
  assert.equal(after.some((entity) => entity.id === "alwaysDefect#2"), true);
  assert.equal(listRelations(world).length, 0);
});

function played(world: World, from: string, to: string): string | undefined {
  const relation = listRelations(world).find((row) => row.from === from && row.to === to);
  const move = relation?.attrs.lastMine;
  return move === "C" || move === "D" ? move : undefined;
}
