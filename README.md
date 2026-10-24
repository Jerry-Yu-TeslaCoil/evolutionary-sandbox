# evolutionary-sandbox

属性、关系，以及每一拍同时执行的策略。

主世界每一拍只做一件事：冻结当前的实体和关系，让每个实体上的每个策略各执行一次，再把这一拍的修改一次落地。策略读到的都是拍初的世界。先写出的修改要等这一拍全部跑完才生效。

同一个数上的修改会加在一起。对同一个值给出不同的覆盖时，这一拍失败，世界保持原样。既有覆盖又有累加时，先取覆盖，再加上累加。追加的文本按实体 id、策略顺序接成逗号分隔的字符串。没有旧值时，累加从 0 起，追加从空文本起。

`(A, B)` 和 `(B, A)` 是两格不同的关系。新实体下一拍才开始执行。实体离场后，任一端是它的关系一起去掉。

一份世界可以带自己的规则。规则和实体策略一样，读的是这一拍开始时的世界，写入等这一拍结束才落地。

## 运行

```bash
npm install
npm start
npm start -- --ticks 12 --every 5 --eliminate 8 --count 3 --seed 1
npm start -- --n 1=5 --n 13=5
npm start -- --world demo
npm test
```

`npm start` 跑以牙还牙。`--world demo` 跑原来的三个人。类别编号和初始人数见 `src/tft.ts` 里的 `defaultTftParams`。

## 写一个策略

策略挂在实体上。它通过 `ctx` 读冻结的世界，用 `set`、`add`、`append`、`remove`、`spawn` 提出修改。

```ts
import { addEntity, createWorld, step, type Strategy } from "./world.ts";

const grow: Strategy = {
  name: "grow",
  run(ctx) {
    ctx.self.add("age", 1);
  },
};

const world = createWorld();
addEntity(world, { id: "a", attrs: { age: 0 }, strategies: [grow] });
step(world);
```
