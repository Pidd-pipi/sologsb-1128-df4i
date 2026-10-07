import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import type { ReviewIssue } from '../types/review';
import { uid } from '../utils/format';

/**
 * 泊位占用重算引擎。
 *
 * 泊位的 占用 / 空闲 / 待核对 一律由进出港流水「重放」得出，流水一改就重算，
 * 泊位表不再另留旧值；维修是人工状态，重算时原样保留。
 *
 * 重放规则（按时间正序处理某泊位的未作废流水）：
 * - 进港：压入一个在港候选；
 * - 出港：优先闭合同船的在港候选，找不到则闭合最早的候选（异船离泊视为顶掉）；
 * - 重放结束后仍未闭合的进港候选：
 *   - 分属 2 条及以上不同渔船 → 冲突，泊位置「待核对」并挂核对单；
 *   - 仅 1 条 → 占用；
 *   - 0 条 → 空闲，离泊时间取最后一条出港流水。
 */

interface ReplayParams {
  calls: readonly PortCall[];
  berths: readonly Berth[];
  reviews: readonly ReviewIssue[];
  now?: string;
}

interface ReplayResult {
  berths: Berth[];
  reviews: ReviewIssue[];
}

function timeKey(call: PortCall): number {
  const t = new Date(call.time).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 同一泊位事件排序：时间优先，其次创建时间，最后 id，保证结果稳定 */
function sortedEvents(list: PortCall[]): PortCall[] {
  return [...list].sort((a, b) => {
    const t = timeKey(a) - timeKey(b);
    if (t !== 0) return t;
    const c = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });
}

/** 重放单个泊位的流水，得出该泊位的派生状态 */
function replayBerth(events: PortCall[], now: string): {
  status: Berth['status'];
  vesselId: string | null;
  vesselName: string | null;
  berthAt: string | null;
  leaveAt: string | null;
  candidates: PortCall[];
} {
  const ordered = sortedEvents(events);
  const open: PortCall[] = [];
  let lastOutTime: string | null = null;

  for (const ev of ordered) {
    if (ev.type === '进港') {
      open.push(ev);
    } else {
      lastOutTime = ev.time;
      const sameVessel = open.findIndex((c) => c.vesselId === ev.vesselId);
      if (sameVessel >= 0) open.splice(sameVessel, 1);
      else open.shift();
    }
  }

  if (open.length === 0) {
    return {
      status: '空闲',
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: lastOutTime,
      candidates: [],
    };
  }

  const distinctVessels = new Set(open.map((c) => c.vesselId));
  if (distinctVessels.size >= 2) {
    return {
      status: '待核对',
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      candidates: open,
    };
  }

  const kept = open.reduce((min, c) => (timeKey(c) < timeKey(min) ? c : min), open[0]);
  return {
    status: '占用',
    vesselId: kept.vesselId,
    vesselName: kept.vesselName,
    berthAt: kept.time,
    leaveAt: null,
    candidates: [],
  };
}

/**
 * 依据当前全部流水重算泊位与核对单。
 * 纯函数：输入快照，输出新的 berths / reviews 数组，便于在 Dexie 迁移事务里复用。
 */
export function replayOccupancy(params: ReplayParams): ReplayResult {
  const now = params.now ?? new Date().toISOString();
  const activeCalls = params.calls.filter((c) => !c.voided && c.portId);

  const nextReviews: ReviewIssue[] = [];
  // 泊位冲突单随本轮重算更新 / 关闭；流水归属等其它核对单原样保留
  for (const review of params.reviews) {
    if (review.kind !== '泊位冲突' || review.status === '已处理') {
      nextReviews.push(review);
      continue;
    }
    const berth = params.berths.find((b) => b.portId === review.portId && b.berthNo === review.berthNo);
    if (!berth || berth.status === '维修') {
      nextReviews.push({
        ...review,
        status: '已处理',
        resolvedAt: now,
        resolution: '泊位已不存在或置为维修，冲突单自动关闭',
      });
    }
  }

  const pendingByBerth = new Map<string, ReviewIssue>(
    params.reviews
      .filter((r) => r.status === '待核对' && r.kind === '泊位冲突')
      .map((r) => [`${r.portId}|${r.berthNo}`, r]),
  );

  const nextBerths = params.berths.map((berth) => {
    if (berth.status === '维修') {
      return { ...berth, reviewId: null };
    }

    const events = activeCalls.filter((c) => c.portId === berth.portId && c.berthNo === berth.berthNo);
    const derived = replayBerth(events, now);
    const key = `${berth.portId}|${berth.berthNo}`;
    const existing = pendingByBerth.get(key);

    if (derived.status !== '待核对') {
      if (existing) {
        // 冲突已随流水更正消除：关闭旧核对单
        nextReviews.push({
          ...existing,
          status: '已处理',
          resolvedAt: now,
          resolution: '冲突已随流水更正消除',
        });
      }
      return {
        ...berth,
        status: derived.status,
        vesselId: derived.vesselId,
        vesselName: derived.vesselName,
        berthAt: derived.berthAt,
        leaveAt: derived.leaveAt,
        reviewId: null,
      };
    }

    const candidateIds = derived.candidates.map((c) => c.id);
    const names = [...new Set(derived.candidates.map((c) => c.vesselName))].join('、');
    const detail = `泊位 ${berth.berthNo} 同时存在 ${candidateIds.length} 条未离泊的进港流水（${names}），请保留一条，其余作废后重算。`;
    const sameSet = existing && [...existing.callIds].sort().join(',') === [...candidateIds].sort().join(',');

    let review: ReviewIssue;
    if (existing && sameSet) {
      review = existing;
    } else if (existing) {
      review = { ...existing, callIds: candidateIds, detail };
    } else {
      review = {
        id: uid('r'),
        kind: '泊位冲突',
        status: '待核对',
        portId: berth.portId,
        berthNo: berth.berthNo,
        callIds: candidateIds,
        detail,
        createdAt: now,
        resolvedAt: null,
        resolution: '',
      };
    }
    nextReviews.push(review);

    return {
      ...berth,
      status: '待核对' as const,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      reviewId: review.id,
    };
  });

  return { berths: nextBerths, reviews: nextReviews };
}

/**
 * 升级旧数据时推断流水的所属渔港。推断不出返回空串，由调用方登记「流水归属」核对单。
 * 依据优先级：泊位现占用渔船 → 同船其它已归属流水 → 渔船船籍港名称包含 → 泊位号全库唯一。
 */
export function inferCallPortId(
  call: PortCall,
  context: {
    ports: { id: string; name: string }[];
    berths: Pick<Berth, 'portId' | 'berthNo' | 'vesselId'>[];
    vessels: { id: string; homePort: string }[];
    knownCallsByVessel: Map<string, string>;
  },
): string {
  const portsWithBerth = context.berths.filter((b) => b.berthNo === call.berthNo);

  const occupiedMatch = portsWithBerth.filter((b) => b.vesselId === call.vesselId);
  if (occupiedMatch.length === 1) return occupiedMatch[0].portId;

  const known = context.knownCallsByVessel.get(call.vesselId);
  if (known && portsWithBerth.some((b) => b.portId === known)) return known;

  const vessel = context.vessels.find((v) => v.id === call.vesselId);
  if (vessel?.homePort) {
    const homeMatch = context.ports.filter(
      (p) => p.name.includes(vessel.homePort) && portsWithBerth.some((b) => b.portId === p.id),
    );
    if (homeMatch.length === 1) return homeMatch[0].id;
  }

  if (occupiedMatch.length === 0) {
    const portIds = new Set(portsWithBerth.map((b) => b.portId));
    if (portIds.size === 1) return [...portIds][0];
  }
  return '';
}
