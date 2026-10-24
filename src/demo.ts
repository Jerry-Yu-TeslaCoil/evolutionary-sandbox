import { addEntity, createWorld, type Strategy, type World } from "./world.ts";

const wave: Strategy = {
  name: "wave",
  run(ctx) {
    ctx.world.relation(ctx.self.id, "bob").set("wave", ctx.self.id);
  },
};

const listen: Strategy = {
  name: "listen",
  run(ctx) {
    const incoming = ctx.world.relation("alice", "bob").attrs.wave;
    if (typeof incoming === "string") ctx.self.set("heard", incoming);
  },
};

const press: Strategy = {
  name: "press",
  run(ctx) {
    ctx.world.relation("alice", "bob").add("pressure", 1);
  },
};

const strike: Strategy = {
  name: "strike",
  run(ctx) {
    const prey = ctx.world.entity("prey");
    if (!prey) return;
    prey.add("energy", -1);
  },
};

const die: Strategy = {
  name: "die",
  run(ctx) {
    const energy = ctx.self.attrs.energy;
    if (typeof energy === "number" && energy <= 0) ctx.self.remove();
  },
};

export function buildDemoWorld(): World {
  const world = createWorld();
  world.name = "演示";
  addEntity(world, {
    id: "alice",
    attrs: { energy: 5 },
    strategies: [wave, press, strike],
  });
  addEntity(world, {
    id: "bob",
    attrs: { energy: 5 },
    strategies: [listen, press, strike],
  });
  addEntity(world, {
    id: "prey",
    attrs: { energy: 4 },
    strategies: [die],
  });
  return world;
}
