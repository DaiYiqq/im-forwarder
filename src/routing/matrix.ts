/**
 * 路由矩阵编译。
 *
 * 路由配置是"源平台:源会话 → 目标平台:目标会话"的有向边集合。
 * 编译阶段做三件事：
 *  1. 结构校验（自环、重复 id、重复边、group 内容归属冲突）；
 *  2. 图分析（检测环、跨 group 环）；
 *  3. 建立 `源键 → 路由列表` 索引，供运行时 O(1) 命中。
 *
 * 环的处理策略：本项目默认链路就是双向的（微信 ↔ QQ），所以"环"本身不是错误；
 * 但环必须由回环防护（loop-guard）兜住，且**不能跨 group** ——
 * 跨 group 的环意味着两条独立链路互相喂消息，指纹防护失效，必须视为配置错误。
 *
 * 错误以结构化 `MatrixIssue` 上报（code/message/routeId），
 * 同时保留字符串形式的 `violations` 以兼容既有调用方。
 */

import type { RouteConfig, RouteTarget } from "../config/schema";
import { checkRouteShape, endpointKey, sameEndpoint } from "../compliance/gates";

export interface CompiledRoute extends RouteConfig {
  order: number;
  /** 目标含 telegram ⇒ 出境边 */
  crossBorder: boolean;
  /** 源为 telegram ⇒ 入境边（不构成 PIPL 第 38 条的"出境"） */
  inboundFromTelegram: boolean;
  to: RouteTarget[];
}

export interface MatrixIssue {
  code: string;
  message: string;
  routeId?: string;
}

export interface MatrixCycle {
  /** 环上的端点键，首尾相同，例如 [A, B, A] */
  nodes: string[];
  /** 构成该环的各条边所属的 group */
  groups: string[];
  crossGroup: boolean;
}

export interface MatrixStats {
  routes: number;
  edges: number;
  groups: number;
  crossBorderEdges: number;
  inboundTelegramEdges: number;
  thirdPartyRoutes: number;
}

export class RouteMatrixError extends Error {
  readonly code = "ROUTE_MATRIX_INVALID";
  readonly issues: MatrixIssue[];
  /** 兼容字符串形式：`${code}：${message}` */
  readonly violations: string[];

  constructor(issues: MatrixIssue[]) {
    super(`路由矩阵不合法（${issues.length} 项）`);
    this.name = "RouteMatrixError";
    this.issues = issues;
    this.violations = issues.map((issue) => `${issue.code}：${issue.message}`);
  }
}

export interface CompileMatrixOptions {
  /**
   * 是否在编译期做路由形状检查（默认 true）。
   * 前置检查（preflight）会先带完整整改建议做一遍，此时传 false 可避免重复上报。
   */
  checkShape?: boolean;
}

export interface CompiledMatrix {
  routes: CompiledRoute[];
  bySource: Map<string, CompiledRoute[]>;
  cycles: MatrixCycle[];
  stats: MatrixStats;
}

interface Edge {
  to: string;
  group: string;
  routeId: string;
}

export function compileMatrix(
  routes: readonly RouteConfig[],
  options: CompileMatrixOptions = {},
): CompiledMatrix {
  const checkShape = options.checkShape ?? true;
  const issues: MatrixIssue[] = [];
  const seenIds = new Set<string>();
  const seenEdges = new Set<string>();
  const groupOwner = new Map<string, "self" | "third-party">();
  const compiled: CompiledRoute[] = [];
  const graph = new Map<string, Edge[]>();

  routes.forEach((route, index) => {
    if (checkShape) {
      for (const shapeViolation of checkRouteShape(route)) {
        issues.push({
          code: shapeViolation.code,
          routeId: shapeViolation.routeId,
          message: shapeViolation.message,
        });
      }
    }

    if (seenIds.has(route.id)) {
      issues.push({ code: "DUPLICATE_ROUTE_ID", routeId: route.id, message: `路由 id 重复：${route.id}` });
    }
    seenIds.add(route.id);

    const owner = groupOwner.get(route.group);
    if (owner && owner !== route.contentOwner) {
      issues.push({
        code: "GROUP_CONTENT_OWNER_CONFLICT",
        routeId: route.id,
        message:
          `group "${route.group}" 内同时存在 contentOwner=self 与 third-party。` +
          "同一链路的内容归属必须一致，否则无法判断哪条消息需要同意。",
      });
    }
    groupOwner.set(route.group, route.contentOwner);

    const fromKey = endpointKey(route.from);
    for (const target of route.to) {
      const targetKey = endpointKey(target);
      const edgeSignature = `${fromKey}->${targetKey}`;
      if (seenEdges.has(edgeSignature)) {
        issues.push({
          code: "DUPLICATE_EDGE",
          routeId: route.id,
          message: `重复路由边 ${edgeSignature}`,
        });
      }
      seenEdges.add(edgeSignature);

      const list = graph.get(fromKey) ?? [];
      list.push({ to: targetKey, group: route.group, routeId: route.id });
      graph.set(fromKey, list);
    }

    compiled.push({
      ...route,
      to: route.to.map((target) => ({
        platform: target.platform,
        conversationId: target.conversationId,
        chatType: target.chatType,
        ...(target.receiver ? { receiver: { ...target.receiver } } : {}),
      })),
      order: index,
      crossBorder: route.to.some((target) => target.platform === "telegram"),
      inboundFromTelegram: route.from.platform === "telegram",
    });
  });

  if (issues.length > 0) {
    throw new RouteMatrixError(issues);
  }

  const bySource = new Map<string, CompiledRoute[]>();
  for (const route of compiled) {
    const key = endpointKey(route.from);
    const list = bySource.get(key) ?? [];
    list.push(route);
    bySource.set(key, list);
  }

  const cycles = findCycles(graph);
  for (const cycle of cycles) {
    if (cycle.crossGroup) {
      issues.push({
        code: "CYCLE_ACROSS_GROUPS",
        message:
          `路由环跨越多个 group（${cycle.groups.join(" / ")}）：${cycle.nodes.join(" → ")}。` +
          "跨 group 的环会让内容指纹防护失效，请合并 group 或删除其中一条边。",
      });
    }
  }

  if (issues.length > 0) {
    throw new RouteMatrixError(issues);
  }

  return {
    routes: compiled,
    bySource,
    cycles,
    stats: {
      routes: compiled.length,
      edges: compiled.reduce((sum, route) => sum + route.to.length, 0),
      groups: new Set(compiled.map((route) => route.group)).size,
      crossBorderEdges: compiled.filter((route) => route.crossBorder).length,
      inboundTelegramEdges: compiled.filter((route) => route.inboundFromTelegram).length,
      thirdPartyRoutes: compiled.filter((route) => route.contentOwner === "third-party").length,
    },
  };
}

/** 找出所有环，并标记每个环是否跨越多个 group。 */
export function findCycles(graph: Map<string, Edge[]>): MatrixCycle[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stackNodes: string[] = [];
  const stackEdges: Edge[] = [];
  const found = new Map<string, MatrixCycle>();

  const visit = (node: string): void => {
    state.set(node, 1);
    stackNodes.push(node);

    for (const edge of graph.get(node) ?? []) {
      const nextState = state.get(edge.to) ?? 0;
      if (nextState === 0) {
        stackEdges.push(edge);
        visit(edge.to);
        stackEdges.pop();
      } else if (nextState === 1) {
        const cycleStart = stackNodes.lastIndexOf(edge.to);
        if (cycleStart >= 0) {
          const nodes = [...stackNodes.slice(cycleStart), edge.to];
          const edgeGroups = [...stackEdges.slice(cycleStart).map((item) => item.group), edge.group];
          const groups = [...new Set(edgeGroups)];
          const key = canonicalCycleKey(nodes);
          if (!found.has(key)) {
            found.set(key, { nodes, groups, crossGroup: groups.length > 1 });
          }
        }
      }
    }

    stackNodes.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) {
      visit(node);
    }
  }

  return [...found.values()];
}

function canonicalCycleKey(nodes: string[]): string {
  // 环首尾相同：去掉尾部重复项后，旋转到字典序最小的起点再拼接，保证 A→B→A 与 B→A→B 视为同一个环。
  const ring = nodes.slice(0, -1);
  if (ring.length === 0) return "";
  let best = 0;
  for (let i = 1; i < ring.length; i += 1) {
    if ((ring[i] as string) < (ring[best] as string)) best = i;
  }
  const rotated = [...ring.slice(best), ...ring.slice(0, best)];
  return rotated.join("→");
}

/** 判断目标端点是否已构成自环（供调试/测试使用）。 */
export function isSelfLoop(route: RouteConfig): boolean {
  return route.to.some((target) => sameEndpoint(route.from, target));
}
