/**
 * Async generator function that is supposed to
 *   - add/alter/drop messages flowing through it
 *   - perform side-effects based on messages flowing through it.
 */
export interface Stage<TMsg> {
  (input: AsyncIterable<TMsg>): AsyncIterable<TMsg>;
}

/**
 * Represents sum of multiple `addStage(…)`'s acting on messages `.put(…)` into it.
 * `.fork(…)` can be used to have multiple instances of the same set of `Stage`'s.
 * No stage execution occur unless async iteration happens on the pipeline
 * (and values are `.put(…)` into it).
 */
export class Pipeline<TMsg> {
  private _stages: Array<Stage<TMsg>>;
  private _pipelineStart = new Channel<TMsg>();
  private _pipelineEnd: AsyncIterable<TMsg> | null = null;
  private _composeStages() {
    this._pipelineEnd = this._stages.reduce<AsyncIterable<TMsg>>(
      (prevStage, stage) => stage(prevStage),
      this._pipelineStart,
    );
    return this._pipelineEnd;
  }
  constructor(...stages: Array<Stage<TMsg>>) {
    this._stages = stages;
  }
  [Symbol.asyncIterator]() {
    if (!this._pipelineEnd) this._composeStages();
    return this._pipelineEnd![Symbol.asyncIterator]();
  }
  addStage(stage: Stage<TMsg>) {
    this._pipelineEnd = null;
    this._stages.push(stage);
    return this; // several `.addStage(…)` can be chained
  }
  put = (msg: TMsg) => {
    this._pipelineStart.send(msg);
    // `return this` wouldn't allow TypeScript to use `.put` as an event handler
  };
  fork() {
    return new Pipeline(...this._stages);
  }
}

/**
 * Produces a `Stage` that runs `Pipeline` for each unique `.pickKey(i)` result.
 */
export function branchStage<TMsg>(
  pickKey: (msg: TMsg) => unknown,
  branchPipeline: Pipeline<TMsg>,
): Stage<TMsg> {
  const handleBranchesKey: unknown = Symbol("handleBranchesKey");
  return async function* branchStageImpl(input) {
    async function* handleBranches() {
      for await (const msg of input) {
        const key = msg === null ? null : pickKey(msg);
        if (key === null) {
          yield msg;
          continue;
        }
        let pipeline: Pipeline<TMsg> | Pipeline<TMsg | null>;
        if (combinator.has(key)) {
          pipeline = combinator.get(key)!;
        } else {
          pipeline = branchPipeline.fork();
          combinator.set(key, pipeline);
        }
        pipeline.put(msg);
        yield null;
      }
    }
    const combinator = new BranchCombinator<
      TMsg | null,
      unknown,
      Pipeline<TMsg> | Pipeline<TMsg | null>
    >([handleBranchesKey, new Pipeline(handleBranches)]);
    for await (const [result, key] of combinator) {
      if (result.done) {
        if (key == handleBranchesKey) return result.value;
      } else {
        if (result.value !== null) yield result.value;
      }
    }
  };
}

/**
 * Imitates push semantics by automatically pulling side-effects from given arg.
 */
export class AutoRun {
  private _isStopped = false;
  private async _loop(input: AsyncIterable<unknown>) {
    for await (const _ of input) {
      if (this._isStopped) break;
    }
  }
  private _makeStoppable(input: AsyncIterable<unknown>) {
    const stopPromise = new Promise<IteratorResult<unknown>>((resolve) => {
      this.stop = () => {
        this._isStopped = true;
        resolve({ done: true, value: null });
      };
    });
    return {
      next: () => {
        const nextPromise = this._isStopped
          ? stopPromise // to avoid calling .next() when `._isStopped`
          : input[Symbol.asyncIterator]().next();
        return Promise.race([nextPromise, stopPromise]);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  constructor(input: AsyncIterable<unknown>) {
    this.stopped = this._loop(this._makeStoppable(input));
  }
  stopped: Promise<void>;
  stop() {
    // implemented in `._makeStoppable()`
  }
}

/**
 * Prevents `AsyncIterable` from being `done` when exiting the loop on it.
 */
export function protectFromReturn<TMsg>(input: AsyncIterable<TMsg>) {
  const asyncIter = input[Symbol.asyncIterator]();
  return {
    next() {
      return asyncIter.next();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

class Channel<TMsg> {
  private _queue: TMsg[] = [];
  private _pauseController = new PauseController();
  private _asyncIter: AsyncIterator<TMsg>;
  constructor() {
    this._asyncIter = this._input();
  }
  private async *_input() {
    while (true) {
      while (this._queue.length) {
        const e = this._queue.shift();
        if (e === undefined) continue;
        yield e;
      }
      await this._pauseController.pause();
    }
  }
  [Symbol.asyncIterator]() {
    return this._asyncIter;
  }
  send(msg: TMsg) {
    this._queue.push(msg);
    this._pauseController.run();
  }
}

class PauseController {
  private _pausePromise: Promise<void> = Promise.resolve();
  private _stopWaiting(): void {}
  private _exposeResolve = (resolve: () => void) => {
    this._stopWaiting = resolve;
  };
  constructor() {
    this.run();
  }
  run() {
    this?._stopWaiting?.();
    this._pausePromise = new Promise(this._exposeResolve);
  }
  pause() {
    return this._pausePromise;
  }
}

class BranchCombinator<TMsg, TKey, TIterable extends AsyncIterable<TMsg>>
  implements AsyncIterable<readonly [IteratorResult<TMsg>, TKey]> {
  private _branchMap = new Map<TKey, TIterable>();
  private _promiseMap = new Map<TKey, NextPromise<TMsg, TKey>>();
  private _asyncIter: AsyncIterator<
    readonly [IteratorResult<TMsg>, TKey],
    void,
    undefined
  >;
  private async *_loop() {
    while (true) {
      if (this._promiseMap.size === 0) break;
      const [result, key] = await Promise.race(this._promiseMap.values());
      const branch = this._branchMap.get(key);
      if (!branch) throw new Error();
      yield [result, key] as const;
      if (result.done) {
        this._branchMap.delete(key);
        this._promiseMap.delete(key);
      } else {
        this._promiseMap.set(key, getNextPromise(branch, key));
      }
    }
  }
  constructor(...branches: Array<[TKey, TIterable]>) {
    branches.forEach((entry) => this.set(...entry));
    this._asyncIter = this._loop();
  }
  [Symbol.asyncIterator]() {
    return this._asyncIter;
  }
  has(key: TKey) {
    return this._branchMap.has(key);
  }
  get(key: TKey) {
    return this._branchMap.get(key);
  }
  set(key: TKey, branch: TIterable) {
    this._branchMap.set(key, branch);
    this._promiseMap.set(key, getNextPromise(branch, key));
  }
}

type NextPromise<TMsg, TAttached> = Promise<
  readonly [IteratorResult<TMsg>, TAttached]
>;
async function getNextPromise<TMsg, TAttached>(
  input: AsyncIterable<TMsg>,
  attached: TAttached,
): NextPromise<TMsg, TAttached> {
  const result = await input[Symbol.asyncIterator]().next();
  return [result, attached];
}
