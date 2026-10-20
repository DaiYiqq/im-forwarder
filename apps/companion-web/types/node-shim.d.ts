/**
 * 最小 Node 内建模块类型声明（仅测试代码使用）。
 *
 * 为什么手写而不是装 @types/node：本包依赖白名单只允许
 * @capacitor/* + esbuild + typescript，不允许额外引入类型包。
 * 测试只用到 node:test 与 node:assert/strict 的一小部分 API，
 * 声明这几行足够让 `tsc --noEmit` 覆盖 test/**\/*.ts。
 *
 * 注意：这里只有类型、没有运行时实现。测试运行时由 Node 内建模块提供。
 */

declare module "node:test" {
  export interface TestContext {
    readonly name: string;
  }
  export type TestFn = (context: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
        throws(fn: () => unknown, expected?: RegExp | Error | ((error: unknown) => boolean), message?: string): void;
    rejects(
      fn: () => Promise<unknown>,
      expected?: RegExp | Error | ((error: unknown) => boolean),
      message?: string,
    ): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
