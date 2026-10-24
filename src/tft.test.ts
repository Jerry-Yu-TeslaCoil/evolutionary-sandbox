import assert from "node:assert/strict";
import { test } from "node:test";
import { birthReach, createTftWorld, defaultTftParams, flipMove, formatPopulationSpacing, moveOf, nearestCount, normalizePositions, normalizeTftParams, populationSpacing, rankCounts, rememberCounts, sameScoresAtSelection, spreadWeights, strayCount, tftRankingNote } from "./tft.ts";
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
    near: 1,
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
    near: 1,
  });
  step(calm);
  step(calm);
  step(calm);
  assert.equal(played(calm, "forgivingTft#1", "alwaysCooperate#1"), "C");
});

test("同质化只加总上一拍见过的对待，开局和平局都合作", () => {
  const tied = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 1, tft: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1 / 2,
    ...still,
  });
  park(tied, "homogenized#1", 0);
  park(tied, "alwaysCooperate#1", 1);
  park(tied, "alwaysDefect#1", 3);
  park(tied, "tft#1", 100);
  park(tied, "tft#2", 101);
  step(tied);
  assert.equal(played(tied, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(tied, "homogenized#1", "alwaysDefect#1"), "C");
  assert.equal(played(tied, "homogenized#1", "tft#1"), undefined);
  step(tied);
  assert.equal(played(tied, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(tied, "homogenized#1", "alwaysDefect#1"), "C");

  const hostile = createTftWorld({
    counts: { homogenized: 1, alwaysDefect: 2, tft: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1 / 2,
    ...still,
  });
  park(hostile, "homogenized#1", 0);
  park(hostile, "alwaysDefect#1", 1);
  park(hostile, "alwaysDefect#2", 2);
  park(hostile, "tft#1", 100);
  park(hostile, "tft#2", 101);
  step(hostile);
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#1"), "C");
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#2"), "C");
  step(hostile);
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#1"), "D");
  assert.equal(played(hostile, "homogenized#1", "alwaysDefect#2"), "D");
  assert.equal(played(hostile, "homogenized#1", "tft#1"), undefined);
});

test("同质化的判断比例可以改成更乐观或更悲观", () => {
  assert.equal(moveOf("homogenized", { worldC: 1, worldD: 1, ratio: 0.7 }), "D");
  assert.equal(moveOf("homogenized", { worldC: 1, worldD: 2, ratio: 0.3 }), "C");
  assert.equal(moveOf("homogenized", { ratio: 1 }), "C");

  const pessimistic = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 1, tft: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    ratio: 0.7,
    near: 1 / 2,
    ...still,
  });
  park(pessimistic, "homogenized#1", 0);
  park(pessimistic, "alwaysCooperate#1", 1);
  park(pessimistic, "alwaysDefect#1", 3);
  park(pessimistic, "tft#1", 100);
  park(pessimistic, "tft#2", 101);
  step(pessimistic);
  step(pessimistic);
  assert.equal(played(pessimistic, "homogenized#1", "alwaysCooperate#1"), "D");
  assert.equal(played(pessimistic, "homogenized#1", "alwaysDefect#1"), "D");

  const optimistic = createTftWorld({
    counts: { homogenized: 1, alwaysCooperate: 1, alwaysDefect: 2, tft: 4 },
    every: 10,
    eliminate: 1,
    seed: 1,
    ratio: 1 / 3,
    near: 1 / 2,
    ...still,
  });
  park(optimistic, "homogenized#1", 0);
  park(optimistic, "alwaysCooperate#1", 1);
  park(optimistic, "alwaysDefect#1", 2);
  park(optimistic, "alwaysDefect#2", 3);
  park(optimistic, "tft#1", 100);
  park(optimistic, "tft#2", 101);
  park(optimistic, "tft#3", 200);
  park(optimistic, "tft#4", 201);
  step(optimistic);
  step(optimistic);
  assert.equal(played(optimistic, "homogenized#1", "alwaysCooperate#1"), "C");
  assert.equal(played(optimistic, "homogenized#1", "alwaysDefect#1"), "C");
  assert.equal(played(optimistic, "homogenized#1", "alwaysDefect#2"), "C");
});

test("爆发者对同一个人最近 5 次里被背叛达到 3 次后永远背叛", () => {
  const world = createTftWorld({
    counts: { burster: 1, alwaysDefect: 1, alwaysCooperate: 1, tft: 2 },
    every: 20,
    eliminate: 1,
    seed: 1,
    near: 1 / 2,
    ...still,
  });
  park(world, "burster#1", 0);
  park(world, "alwaysDefect#1", 1);
  park(world, "alwaysCooperate#1", 2);
  park(world, "tft#1", 100);
  park(world, "tft#2", 101);
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

test("爆发者的回看次数和背叛次数可以改", () => {
  assert.equal(moveOf("burster", { recent: "D", burstWindow: 4, burstStrikes: 2 }), "C");
  assert.equal(moveOf("burster", { recent: "CDCD", burstWindow: 4, burstStrikes: 2 }), "D");
  assert.equal(moveOf("burster", { recent: "DDDCC", burstWindow: 3, burstStrikes: 2 }), "C");

  const world = createTftWorld({
    counts: { burster: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1,
    window: 2,
    strikes: 1,
  });
  step(world);
  assert.equal(played(world, "burster#1", "alwaysDefect#1"), "C");
  step(world);
  assert.equal(played(world, "burster#1", "alwaysDefect#1"), "D");
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
  assert.match(mixed, /最近对手的比例是 0\.333333/);
  assert.match(mixed, /意外相遇再从剩下的人里随机抽 0/);
  assert.match(mixed, /计划跑 30 拍，排名取第 10 拍开始时的人数/);

  const even = tftRankingNote(defaultTftParams, 12, 12);
  assert.match(even, /每类 3 人/);
  assert.match(even, /判断比例是 0\.5/);
  assert.match(even, /0 的概率/);
  assert.match(even, /分数死区是最高分的 0/);
  assert.match(even, /最近对手的比例是 0\.333333/);
  assert.match(even, /意外相遇再从剩下的人里随机抽 0/);
  assert.match(even, /最近 5 次里被背叛达到 3 次/);
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
    near: 1,
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
    near: 1,
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
    near: 1,
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
  park(tied, "tft#1", 0);
  park(tied, "alwaysCooperate#1", 1);
  park(tied, "tft#2", 100);
  park(tied, "alwaysCooperate#2", 101);
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
    near: 1,
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
  park(world, "alwaysCooperate#1", 0);
  park(world, "alwaysDefect#1", 1);
  park(world, "alwaysCooperate#2", 50);
  park(world, "alwaysDefect#2", 51);
  step(world);
  const before = listEntities(world).map((entity) => [entity.id, entity.attrs.kind, entity.attrs.score]);
  assert.deepEqual(before, [
    ["alwaysCooperate#1", "alwaysCooperate", 0],
    ["alwaysCooperate#2", "alwaysCooperate", 0],
    ["alwaysDefect#1", "alwaysDefect", 5],
    ["alwaysDefect#2", "alwaysDefect", 5],
  ]);
  step(world);
  const after = listEntities(world);
  assert.equal(after.length, 4);
  assert.equal(after.every((entity) => entity.attrs.kind === "alwaysDefect" && entity.attrs.score === 0), true);
  assert.equal(after.some((entity) => entity.id === "alwaysDefect#1"), true);
  assert.equal(after.some((entity) => entity.id === "alwaysDefect#2"), true);
  assert.equal(listRelations(world).length, 0);
});

test("按这一拍开始时的距离移动", () => {
  const cooperators = createTftWorld({
    counts: { alwaysCooperate: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1,
  });
  const left = spot(cooperators, "alwaysCooperate#1");
  const right = spot(cooperators, "alwaysCooperate#2");
  step(cooperators);
  const approached = normalizePositions([shift(left, right, 0.2), shift(right, left, 0.2)]);
  closeTo(spot(cooperators, "alwaysCooperate#1"), approached[0] ?? left);
  closeTo(spot(cooperators, "alwaysCooperate#2"), approached[1] ?? right);

  const defectors = createTftWorld({
    counts: { alwaysDefect: 2 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1,
  });
  const stillLeft = spot(defectors, "alwaysDefect#1");
  const stillRight = spot(defectors, "alwaysDefect#2");
  step(defectors);
  const stayed = normalizePositions([stillLeft, stillRight]);
  closeTo(spot(defectors, "alwaysDefect#1"), stayed[0] ?? stillLeft);
  closeTo(spot(defectors, "alwaysDefect#2"), stayed[1] ?? stillRight);

  const split = createTftWorld({
    counts: { alwaysCooperate: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
    near: 1,
  });
  const cooperator = spot(split, "alwaysCooperate#1");
  const defector = spot(split, "alwaysDefect#1");
  step(split);
  const parted = normalizePositions([shift(cooperator, defector, -0.45), shift(defector, cooperator, 0.15)]);
  closeTo(spot(split, "alwaysCooperate#1"), parted[0] ?? cooperator);
  closeTo(spot(split, "alwaysDefect#1"), parted[1] ?? defector);

  const cling = createTftWorld({
    counts: { alwaysCooperate: 1, alwaysDefect: 1 },
    every: 10,
    eliminate: 1,
    seed: 1,
    flee: -0.2,
    near: 1,
  });
  const bitten = spot(cling, "alwaysCooperate#1");
  const biter = spot(cling, "alwaysDefect#1");
  step(cling);
  const clung = normalizePositions([shift(bitten, biter, 0.2), shift(biter, bitten, 0.15)]);
  closeTo(spot(cling, "alwaysCooperate#1"), clung[0] ?? bitten);
  closeTo(spot(cling, "alwaysDefect#1"), clung[1] ?? biter);

  const born = createTftWorld({
    counts: { alwaysCooperate: 2, alwaysDefect: 2 },
    every: 1,
    eliminate: 2,
    seed: 1,
  });
  park(born, "alwaysCooperate#1", 0);
  park(born, "alwaysDefect#1", 1);
  park(born, "alwaysCooperate#2", 50);
  park(born, "alwaysDefect#2", 51);
  step(born);
  step(born);
  const keptLeft = spot(born, "alwaysDefect#1");
  const keptRight = spot(born, "alwaysDefect#2");
  const middle = { x: (keptLeft.x + keptRight.x) / 2, y: (keptLeft.y + keptRight.y) / 2 };
  closeTo(middle, { x: 0, y: 0 });
  assert.ok(Math.abs(Math.hypot(keptLeft.x - middle.x, keptLeft.y - middle.y) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(keptRight.x - middle.x, keptRight.y - middle.y) - 1) < 1e-9);
  const children = listEntities(born).filter((entity) => entity.id !== "alwaysDefect#1" && entity.id !== "alwaysDefect#2");
  assert.equal(children.length, 2);
  for (const child of children) {
    const x = child.attrs.x;
    const y = child.attrs.y;
    assert.equal(typeof x, "number");
    assert.equal(typeof y, "number");
    const nearestParent = Math.min(
      Math.hypot((x as number) - keptLeft.x, (y as number) - keptLeft.y),
      Math.hypot((x as number) - keptRight.x, (y as number) - keptRight.y),
    );
    assert.ok(nearestParent <= birthReach + 1e-9);
  }
});

test("淘汰人数是 0 时仍按间隔把坐标缩放到固定尺度", () => {
  const world = createTftWorld({
    counts: { alwaysCooperate: 2 },
    every: 1,
    eliminate: 0,
    seed: 1,
    near: 1,
    ...still,
  });
  park(world, "alwaysCooperate#1", 0);
  park(world, "alwaysCooperate#2", 40);
  step(world);
  assert.equal(listEntities(world).every((entity) => entity.attrs.score === 3), true);
  step(world);
  closeTo(spot(world, "alwaysCooperate#1"), { x: -1, y: 0 });
  closeTo(spot(world, "alwaysCooperate#2"), { x: 1, y: 0 });
  assert.equal(listEntities(world).length, 2);
  assert.equal(listEntities(world).every((entity) => entity.attrs.score === 3), true);
  assert.equal(listRelations(world).length, 2);
});

test("繁衍时把坐标缩放到固定尺度，重叠的人放到原点", () => {
  const fitted = normalizePositions([
    { x: 1e10, y: 0 },
    { x: 1e10 + 4, y: 0 },
  ]);
  closeTo(fitted[0] ?? { x: 0, y: 0 }, { x: -1, y: 0 });
  closeTo(fitted[1] ?? { x: 0, y: 0 }, { x: 1, y: 0 });
  const piled = normalizePositions([
    { x: 5, y: 5 },
    { x: 5, y: 5 },
  ]);
  closeTo(piled[0] ?? { x: 1, y: 1 }, { x: 0, y: 0 });
  closeTo(piled[1] ?? { x: 1, y: 1 }, { x: 0, y: 0 });
});

test("每人只和最近的一部分人打，名额向下取整，对方算进来也会打", () => {
  assert.equal(nearestCount(2, 1 / 3), 0);
  assert.equal(nearestCount(3, 1 / 3), 0);
  assert.equal(nearestCount(4, 1 / 3), 1);
  assert.equal(nearestCount(5, 1 / 3), 1);
  assert.equal(nearestCount(48, 1 / 3), 15);
  assert.equal(nearestCount(5, 1), 4);
  assert.equal(nearestCount(5, 0), 0);

  const world = createTftWorld({
    counts: { alwaysCooperate: 4 },
    every: 10,
    eliminate: 1,
    seed: 1,
    ...still,
  });
  park(world, "alwaysCooperate#1", 0);
  park(world, "alwaysCooperate#2", 1);
  park(world, "alwaysCooperate#3", 1.2);
  park(world, "alwaysCooperate#4", 100);
  step(world);
  assert.equal(played(world, "alwaysCooperate#1", "alwaysCooperate#2"), "C");
  assert.equal(played(world, "alwaysCooperate#2", "alwaysCooperate#3"), "C");
  assert.equal(played(world, "alwaysCooperate#1", "alwaysCooperate#3"), undefined);
  assert.equal(played(world, "alwaysCooperate#1", "alwaysCooperate#4"), undefined);
});

test("意外相遇从最近名额剩下的人里随机抽，远近不管", () => {
  assert.equal(strayCount(4, 1 / 3, 0), 0);
  assert.equal(strayCount(4, 1 / 3, 1 / 2), 1);
  assert.equal(strayCount(4, 1 / 3, 1), 2);
  assert.equal(strayCount(4, 1, 1), 0);
  assert.equal(strayCount(5, 0, 1 / 2), 2);
  assert.throws(() => normalizeTftParams({ ...defaultTftParams, stray: 1.2 }), /意外相遇的比例/);

  const meet = (stray: number, seed: number) => {
    const world = createTftWorld({
      counts: { alwaysCooperate: 4 },
      every: 10,
      eliminate: 1,
      seed,
      near: 1 / 3,
      stray,
      ...still,
    });
    park(world, "alwaysCooperate#1", 0);
    park(world, "alwaysCooperate#2", 1);
    park(world, "alwaysCooperate#3", 3);
    park(world, "alwaysCooperate#4", 100);
    step(world);
    return world;
  };

  const quiet = meet(0, 1);
  assert.equal(played(quiet, "alwaysCooperate#1", "alwaysCooperate#2"), "C");
  assert.equal(played(quiet, "alwaysCooperate#1", "alwaysCooperate#3"), undefined);
  assert.equal(played(quiet, "alwaysCooperate#1", "alwaysCooperate#4"), undefined);

  const everyone = meet(1, 1);
  assert.equal(played(everyone, "alwaysCooperate#1", "alwaysCooperate#4"), "C");

  const pairsOf = (world: World) =>
    ["alwaysCooperate#2", "alwaysCooperate#3", "alwaysCooperate#4"]
      .filter((id) => played(world, "alwaysCooperate#1", id) !== undefined)
      .join(",");
  const first = pairsOf(meet(1 / 2, 1));
  assert.equal(pairsOf(meet(1 / 2, 1)), first);

  let sawFar = false;
  let sawCloser = false;
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed += 1) {
    const world = meet(1 / 2, seed);
    const far = played(world, "alwaysCooperate#1", "alwaysCooperate#4") !== undefined;
    const closer = played(world, "alwaysCooperate#1", "alwaysCooperate#3") !== undefined;
    if (far && !closer) sawFar = true;
    if (closer && !far) sawCloser = true;
    seen.add(`${far}-${closer}`);
  }
  assert.equal(sawFar, true);
  assert.equal(sawCloser, true);
  assert.ok(seen.size > 1);
});

test("内聚是种群内部的平均距离，种群之间另算", () => {
  const spacing = populationSpacing([
    { id: "a", attrs: { order: 0, label: "甲", x: 0, y: 0 } },
    { id: "b", attrs: { order: 0, label: "甲", x: 4, y: 0 } },
    { id: "c", attrs: { order: 1, label: "乙", x: 0, y: 3 } },
    { id: "d", attrs: { order: 1, label: "乙", x: 0, y: 3 } },
  ]);
  const jia = spacing.cohorts.find((row) => row.label === "甲");
  const yi = spacing.cohorts.find((row) => row.label === "乙");
  assert.equal(jia?.cohesion, 4);
  assert.equal(yi?.cohesion, 0);
  assert.equal(spacing.separations[0]?.mean, 4);
  const text = formatPopulationSpacing(spacing);
  assert.match(text, /距离按最远的一组缩放到 1/);
  assert.match(text, /乙  内聚 0\.000/);
  assert.match(text, /甲  内聚 1\.000/);
  assert.match(text, /甲 和 乙，1\.000/);
  assert.equal(text.includes("从近到远"), false);
});

const still = { approach: 0, coexist: 0, follow: 0, flee: 0 };

function park(world: World, id: string, x: number, y = 0): void {
  const entity = world.entities.get(id);
  if (!entity) throw new Error(`没有 ${id}`);
  entity.attrs.x = x;
  entity.attrs.y = y;
}

function spot(world: World, id: string): { x: number; y: number } {
  const entity = listEntities(world).find((item) => item.id === id);
  assert.equal(typeof entity?.attrs.x, "number");
  assert.equal(typeof entity?.attrs.y, "number");
  return { x: entity?.attrs.x as number, y: entity?.attrs.y as number };
}

function shift(from: { x: number; y: number }, toward: { x: number; y: number }, scale: number): { x: number; y: number } {
  return {
    x: from.x + (toward.x - from.x) * scale,
    y: from.y + (toward.y - from.y) * scale,
  };
}

function closeTo(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
}

function played(world: World, from: string, to: string): string | undefined {
  const relation = listRelations(world).find((row) => row.from === from && row.to === to);
  const move = relation?.attrs.lastMine;
  return move === "C" || move === "D" ? move : undefined;
}
