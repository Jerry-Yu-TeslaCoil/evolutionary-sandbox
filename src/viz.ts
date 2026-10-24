import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listEntities, step, type World } from "./world.ts";
import { createTftWorld, defaultTftParams, normalizeTftParams, sameScoresAtSelection, tftCategories, type TftParams } from "./tft.ts";

const port = Number(process.env.PORT) || 4173;
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const files: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/view.css": "view.css",
  "/view.js": "view.js",
};
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

interface Group {
  order: number;
  label: string;
  count: number;
}

interface Snapshot {
  phase: "idle" | "running" | "paused" | "finished";
  tick: number;
  population: number;
  message: string;
  entities: { x: number; y: number; order: number; label: string }[];
  groups: Group[];
}

interface Session {
  world: World | null;
  params: TftParams | null;
  phase: Snapshot["phase"];
  message: string;
  maxTicks: number;
  delay: number;
  stepped: number;
  timer: NodeJS.Timeout | null;
}

const session: Session = {
  world: null,
  params: null,
  phase: "idle",
  message: "设定参数后按开始。",
  maxTicks: 0,
  delay: 80,
  stepped: 0,
  timer: null,
};

const clients = new Set<ServerResponse>();

function snapshot(): Snapshot {
  const world = session.world;
  if (!world) {
    return { phase: session.phase, tick: 0, population: 0, message: session.message, entities: [], groups: [] };
  }
  const entities = listEntities(world).flatMap((entity) => {
    const order = entity.attrs.order;
    const label = entity.attrs.label;
    const x = entity.attrs.x;
    const y = entity.attrs.y;
    if (typeof order !== "number" || typeof label !== "string") return [];
    return [{
      x: typeof x === "number" && Number.isFinite(x) ? x : 0,
      y: typeof y === "number" && Number.isFinite(y) ? y : 0,
      order,
      label,
    }];
  });
  const groups = new Map<number, Group>();
  for (const entity of entities) {
    const group = groups.get(entity.order) ?? { order: entity.order, label: entity.label, count: 0 };
    group.count += 1;
    groups.set(entity.order, group);
  }
  return {
    phase: session.phase,
    tick: world.tick,
    population: entities.length,
    message: session.message,
    entities,
    groups: [...groups.values()].sort((a, b) => a.order - b.order),
  };
}

function broadcast(): void {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(payload);
}

function clearTimer(): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
}

function finish(message: string): void {
  clearTimer();
  session.phase = "finished";
  session.message = message;
  broadcast();
}

function haltReason(): string {
  const world = session.world;
  const params = session.params;
  if (!world || !params) return "";
  if (session.maxTicks > 0 && session.stepped >= session.maxTicks) return "已到达最多拍数。";
  const kinds = new Set(listEntities(world).map((entity) => entity.attrs.kind));
  if (kinds.size <= 1) return "只剩一种策略，提前结束。";
  const dead = params.dead ?? 0;
  if (sameScoresAtSelection(world, params.every, dead)) {
    return dead === 0
      ? "所有人分数相同，结果已经固定，提前结束。"
      : `所有人分数的差距不超过最高分的 ${dead}，结果已经固定，提前结束。`;
  }
  return "";
}

function advance(): void {
  if (session.phase !== "running" || !session.world) return;
  const reason = haltReason();
  if (reason) {
    finish(reason);
    return;
  }
  try {
    step(session.world);
    session.stepped += 1;
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
    return;
  }
  broadcast();
  schedule();
}

function schedule(): void {
  clearTimer();
  if (session.phase !== "running") return;
  session.timer = setTimeout(advance, session.delay);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function asNumber(raw: unknown, name: string): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(value)) throw new Error(`${name}要是数字`);
  return value;
}

function integer(raw: unknown, name: string): number {
  const value = asNumber(raw, name);
  if (!Number.isInteger(value)) throw new Error(`${name}要是整数`);
  return value;
}

function nonNegativeInt(raw: unknown, name: string): number {
  const value = integer(raw, name);
  if (value < 0) throw new Error(`${name}要是非负整数`);
  return value;
}

function positiveInt(raw: unknown, name: string): number {
  const value = integer(raw, name);
  if (value < 1) throw new Error(`${name}要是正整数`);
  return value;
}

function unit(raw: unknown, name: string): number {
  const text = String(raw ?? "").trim();
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  const value = fraction
    ? Number(fraction[1]) / Number(fraction[2])
    : asNumber(raw, name);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name}要是 0 到 1 之间的数，例如 0.05 或 1/3`);
  if (fraction && Number(fraction[2]) === 0) throw new Error(`${name}的分母不能是 0`);
  return value;
}

function startFrom(body: Record<string, unknown>): void {
  const rawCounts = body.counts;
  if (!rawCounts || typeof rawCounts !== "object") throw new Error("缺少各类人数");
  const counts: Record<string, number> = {};
  for (const category of tftCategories) {
    counts[category.id] = nonNegativeInt((rawCounts as Record<string, unknown>)[category.id], category.label);
  }
  const ticks = nonNegativeInt(body.ticks, "最多拍数");
  const delay = nonNegativeInt(body.delay, "每拍间隔");
  if (delay > 10000) throw new Error("每拍间隔不能超过 10000 毫秒");
  const params = normalizeTftParams({
    counts,
    every: positiveInt(body.every, "繁衍间隔"),
    eliminate: nonNegativeInt(body.eliminate, "淘汰人数"),
    seed: integer(body.seed, "种子"),
    ratio: unit(body.ratio, "判断比例"),
    flip: unit(body.flip, "误会率"),
    dead: unit(body.dead, "分数死区"),
    approach: asNumber(body.approach, "靠近系数"),
    coexist: asNumber(body.coexist, "共存系数"),
    follow: asNumber(body.follow, "跟随系数"),
    flee: asNumber(body.flee, "远离系数"),
    near: unit(body.near, "最近对手比例"),
    stray: unit(body.stray, "意外相遇"),
    window: positiveInt(body.window, "回看次数"),
    strikes: positiveInt(body.strikes, "背叛次数"),
  });
  clearTimer();
  session.world = createTftWorld(params);
  session.params = params;
  session.maxTicks = ticks;
  session.delay = delay;
  session.stepped = 0;
  session.phase = "running";
  session.message = "进行中。";
  broadcast();
  schedule();
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/api/meta") {
    sendJson(response, 200, {
      categories: tftCategories.map((category, index) => ({
        id: category.id,
        label: category.label,
        index: index + 1,
        count: defaultTftParams.counts[category.id] ?? 0,
      })),
      values: {
        ticks: "0",
        every: String(defaultTftParams.every),
        eliminate: String(defaultTftParams.eliminate),
        seed: String(defaultTftParams.seed),
        ratio: String(defaultTftParams.ratio ?? 0.5),
        flip: String(defaultTftParams.flip ?? 0),
        dead: String(defaultTftParams.dead ?? 0),
        approach: String(defaultTftParams.approach ?? 0.2),
        coexist: String(defaultTftParams.coexist ?? 0),
        follow: String(defaultTftParams.follow ?? 0.15),
        flee: String(defaultTftParams.flee ?? 0.45),
        near: "1/3",
        stray: "0",
        window: String(defaultTftParams.window ?? 5),
        strikes: String(defaultTftParams.strikes ?? 3),
        delay: "80",
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && (url.pathname === "/api/start" || url.pathname === "/api/pause" || url.pathname === "/api/stop")) {
    try {
      if (url.pathname === "/api/start") {
        const text = await readBody(request);
        const body = text ? JSON.parse(text) as Record<string, unknown> : {};
        startFrom(body);
      } else if (url.pathname === "/api/pause") {
        if (session.phase === "running") {
          clearTimer();
          session.phase = "paused";
          session.message = "已暂停。";
          broadcast();
        } else if (session.phase === "paused") {
          session.phase = "running";
          session.message = "进行中。";
          broadcast();
          schedule();
        }
      } else if (session.phase === "running" || session.phase === "paused") {
        finish("已停止。");
      }
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const name = files[url.pathname];
  if (request.method === "GET" && name) {
    const extension = name.slice(name.lastIndexOf("."));
    const body = await readFile(join(publicDir, name));
    response.writeHead(200, { "content-type": types[extension] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
    return;
  }
  sendJson(response, 404, { error: "没有这个地址" });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`可视化在 http://127.0.0.1:${port}`);
});
