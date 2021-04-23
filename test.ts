import { assertEquals, assertNotEquals, unreachable } from "asserts";

import { AutoRun, branchStage, Pipeline, protectFromReturn } from "./mod.ts";

Deno.test({
  name:
    "`new Pipeline(…)` does not execute stages without async iteration on it",
  fn() {
    const pipelineWithStagesAddedByMethod = new Pipeline<unknown>();
    pipelineWithStagesAddedByMethod.addStage(stageThatNeverExecutes)
      .addStage(stageThatNeverExecutes)
      .addStage(stageThatNeverExecutes);
    pipelineWithStagesAddedByMethod.put(null);
    pipelineWithStagesAddedByMethod.put(null);
    pipelineWithStagesAddedByMethod.put(null);

    const pipelineWithStagesAddedViaConstructorArgs = new Pipeline(
      stageThatNeverExecutes,
      stageThatNeverExecutes,
      stageThatNeverExecutes,
    );
    pipelineWithStagesAddedViaConstructorArgs.put(null);
    pipelineWithStagesAddedViaConstructorArgs.put(null);
    pipelineWithStagesAddedViaConstructorArgs.put(null);

    async function* stageThatNeverExecutes(input: AsyncIterable<unknown>) {
      for await (const _ of input) {
        yield unreachable();
      }
    }
  },
});

Deno.test({
  name: "Stages are executed when async iteration happens on the pipeline",
  async fn() {
    const pipelineInput = [0, 1, 2, 3];
    const p = new Pipeline<number>(test);
    pipelineInput.forEach(p.put);

    let step = 1;
    for await (const _ of p) {
      const isAllPipelineInputConsumed = step++ === pipelineInput.length;
      if (isAllPipelineInputConsumed) break;
    }

    async function* test(input: AsyncIterable<number>) {
      let step = 0;
      for await (const i of input) {
        assertEquals(i, pipelineInput[step]);
        step++;
        yield i;
      }
    }
  },
});

Deno.test({
  name: "`Pipeline.fork` runs several instances of pipeline independently",
  async fn() {
    const p1 = new Pipeline(countTimesCalled);
    const p2 = p1.fork();
    const p3 = p2.fork();

    for (const p of [p1, p2, p3]) {
      p.put(-1);
      const { value: timesCalled } = await nextAsyncIteration(p);
      assertEquals(timesCalled, 1);
    }

    async function* countTimesCalled(input: AsyncIterable<number>) {
      let timesCalled = 0;
      for await (const _ of input) {
        timesCalled++;
        yield timesCalled;
      }
    }
  },
});

Deno.test({
  name: "`Pipeline.put(…)` ignores `undefined` value",
  async fn() {
    const pipelineInput = [undefined, undefined, undefined, 1];
    const p = new Pipeline(test);
    for (const v of pipelineInput) {
      p.put(v);
    }
    const { value } = await nextAsyncIteration(p);
    assertEquals(value, pipelineInput[pipelineInput.length - 1]);
    async function* test(input: AsyncIterable<unknown>) {
      for await (const i of input) {
        assertNotEquals(i, undefined);
        yield i;
      }
    }
  },
});

Deno.test({
  name: "`Pipeline.put` can be used as event handler",
  async fn() {
    const eventType = "test";
    const p = new Pipeline(test);
    globalThis.addEventListener(eventType, p.put);
    globalThis.dispatchEvent(new Event(eventType));
    await nextAsyncIteration(p);

    async function* test(input: AsyncIterable<Event>) {
      for await (const i of input) {
        assertEquals(i.type, eventType);
        yield i;
      }
    }
  },
});

Deno.test({
  name:
    "`branchStage(...)` can be used to run separate pipeline for every input",
  async fn() {
    type Msg = { id: number; value: number };
    const pipelineInput: Msg[] = [
      { id: 0, value: 1 },
      { id: 1, value: 10 },
      { id: 0, value: 100 },
      { id: 1, value: 1000 },
    ];
    let received: Msg[] = [];
    const branchPl = new Pipeline<Msg>(twice, sum);

    const withoutBranchStage = new Pipeline<Msg>();
    withoutBranchStage.addPipeline(branchPl);
    received = [];
    for (const i of pipelineInput) {
      withoutBranchStage.put(i);
      const { value } = await nextAsyncIteration(withoutBranchStage);
      received.push(value);
    }
    assertEquals(received.map((m) => m.value), [2, 22, 222, 2222]);

    const withBranchStage = new Pipeline<Msg>();
    withBranchStage.addStage(
      branchStage((m: Msg) => m.id, branchPl),
    );
    received = [];
    for (const i of pipelineInput) {
      withBranchStage.put(i);
      const { value } = await nextAsyncIteration(withBranchStage);
      received.push(value);
    }
    assertEquals(received.map((m) => m.value), [2, 20, 202, 2020]);

    async function* twice(input: AsyncIterable<Msg>) {
      for await (const i of input) {
        yield { ...i, value: 2 * i.value };
      }
    }
    async function* sum(input: AsyncIterable<Msg>) {
      let agg = 0;
      for await (const i of input) {
        agg += i.value;
        yield { ...i, value: agg };
      }
    }
  },
});

Deno.test({
  name:
    "`branchStage(...)` does not emit `null` values received from actual branches",
  async fn() {
    type Msg = { id?: number; value: number } | null;
    const pipelineInput: Msg[] = [
      { id: 0, value: 1 },
      { id: 1, value: 10 },
      { id: 0, value: 100 },
      { id: 1, value: 1000 },
    ];
    const p = new Pipeline<Msg>();
    p.addStage(branchStage((m: Msg) => m?.id, test));
    const received: Msg[] = [];
    for (const i of pipelineInput) {
      p.put(i);
      const { value } = await nextAsyncIteration(p);
      received.push(value);
    }
    assertEquals(received, pipelineInput);

    async function* test(input: AsyncIterable<Msg>) {
      for await (const i of input) {
        yield null;
        yield i;
      }
    }
  },
});

Deno.test({
  name: "`new AutoRun(…)` provides async iteration to execute pipeline stages",
  fn() {
    return new Promise((endTest) => {
      const pipelineInput = [0, 1, 2, 3];
      const p = new Pipeline(test);
      pipelineInput.forEach(p.put);
      new AutoRun(p);

      async function* test(input: AsyncIterable<number>) {
        let step = 0;
        for await (const i of input) {
          assertEquals(i, pipelineInput[step]);
          step++;
          const isAllPipelineInputConsumed = step === pipelineInput.length;
          if (isAllPipelineInputConsumed) endTest();
          yield i;
        }
      }
    });
  },
});

Deno.test({
  name:
    "`AutoRun.stop(..)` prevents execution if called when there's no values to process",
  async fn() {
    let lastInputPut = -1;
    let lastInputConsumed = -1;
    const p = new Pipeline(test);

    p.put(++lastInputPut);
    assertEquals(lastInputConsumed, -1);
    await nextAsyncIteration(p);
    assertEquals(lastInputConsumed, 0);

    const whenNoValuesToProcess = new AutoRun(p);
    whenNoValuesToProcess.stop();
    p.put(++lastInputPut);
    p.put(++lastInputPut);
    p.put(++lastInputPut);
    await whenNoValuesToProcess.stopped;
    assertEquals(lastInputConsumed, 0);

    async function* test(input: AsyncIterable<number>) {
      for await (const i of input) {
        lastInputConsumed = i;
        yield i;
      }
    }
  },
});

Deno.test({
  name:
    "`AutoRun.stop(..)` allows to process first value if called after it was scheduled`",
  async fn() {
    let lastInputPut = -1;
    let lastInputConsumed = -1;
    const p = new Pipeline(test);

    p.put(++lastInputPut);
    assertEquals(lastInputConsumed, -1);
    await nextAsyncIteration(p);
    assertEquals(lastInputConsumed, 0);

    const whenThereAreValuesToProcess = new AutoRun(p);
    p.put(++lastInputPut);
    p.put(++lastInputPut);
    p.put(++lastInputPut);
    whenThereAreValuesToProcess.stop();
    await whenThereAreValuesToProcess.stopped;
    assertEquals(lastInputConsumed, 1);

    async function* test(input: AsyncIterable<number>) {
      for await (const i of input) {
        lastInputConsumed = i;
        yield i;
      }
    }
  },
});

Deno.test({
  name:
    "`protectFromReturn(…)` prevents async iterable from being done on loop exit",
  async fn() {
    const normal = test();
    for await (const _ of normal) {
      break;
    }
    const { done: normalDone } = await nextAsyncIteration(normal);
    assertEquals(normalDone, true);

    const protectedFromReturn = protectFromReturn(test());
    for await (const _ of protectedFromReturn) {
      break;
    }
    const { done: protectedDone } = await nextAsyncIteration(
      protectedFromReturn,
    );
    assertEquals(protectedDone, false);

    async function* test() {
      while (true) {
        yield null;
      }
    }
  },
});

function nextAsyncIteration<T>(input: AsyncIterable<T>) {
  return input[Symbol.asyncIterator]().next();
}
