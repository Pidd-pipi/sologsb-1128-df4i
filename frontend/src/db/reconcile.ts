import type { Berth, BerthStatus } from '../types/berth';
import type { PortCall } from '../types/call';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { OccupancyReview, ReviewKind } from '../types/review';

/**
 * 泊位占用重算引擎：以进出港流水为唯一事实源，按时间顺序推导每条船的在港状态，
 * 再汇总到泊位。同一泊位出现两条冲突在港记录时，泊位置为「待核对」并列核对单，
 * 由值班员挑一条保留（另一条流水打上 excludedFromOccupancy 后不再参与重算）。
 */

/** 某条船当前（按流水推导出）的在港状态 */
export interface VesselInPortState {
  vesselId: string;
  vesselName: string;
  /** 最近一条决定其在港的「进港」流水 */
  call: PortCall;
  portId: string;
  berthNo: string;
  berthId: string;
  berthAt: string;
}

export interface BerthConflict {
  portId: string;
  berthNo: string;
  berthId: string;
  states: VesselInPortState[];
}

/** 单泊位占用推导结果 */
export interface BerthComputed {
  status: BerthStatus;
  vesselId: string | null;
  vesselName: string | null;
  berthAt: string | null;
  leaveAt: string | null;
  candidateVesselIds: string[];
  candidateCallIds: string[];
}

export interface ReconcileInput {
  ports: FishingPort[];
  berths: Berth[];
  calls: PortCall[];
  /** 升级迁移时传入已有的待核对单（含已核对的），用于保留人工处理结果、复用 id */
  existingReviews?: OccupancyReview[];
  /**
   * migration：与旧泊位占用比对，对不上的列 occupancy-mismatch；
   * reconcile（默认）：只列重算时仍然存在的冲突 / 缺泊位问题，不做旧值比对。
   */
  mode?: 'migration' | 'reconcile';
  nowIso?: string;
}

export interface ReconcileResult {
  berths: Berth[];
  reviews: OccupancyReview[];
  /** 本次仍然存在的泊位冲突 */
  conflicts: BerthConflict[];
  /** 找不到泊位记录的在港流水 */
  missingBerthCalls: PortCall[];
  /** 缺渔港信息、无法参与重算的流水 */
  unknownPortCalls: PortCall[];
}

function callTimeKey(call: PortCall): number {
  const t = new Date(call.time).getTime();
  return Number.isNaN(t) ? new Date(call.createdAt).getTime() || 0 : t;
}

/**
 * 按时间顺序回放每条船的流水，推导其当前是否在港（以及停在哪个泊位）。
 * 被值班员在待核对中排除的流水不参与推导。
 */
export function computeVesselStates(calls: PortCall[]): Map<string, VesselInPortState> {
  const active = new Map<string, VesselInPortState>();
  const usable = calls
    .filter((c) => !c.excludedFromOccupancy && c.portId && c.berthNo)
    .sort((a, b) => {
      const diff = callTimeKey(a) - callTimeKey(b);
      if (diff !== 0) return diff;
      // 同一时刻：先出港后进港，且以创建时间兜底，保证回放顺序稳定
      const typeOrder = a.type === b.type ? 0 : a.type === '出港' ? -1 : 1;
      if (typeOrder !== 0) return typeOrder;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  for (const call of usable) {
    if (call.type === '出港') {
      active.delete(call.vesselId);
    } else {
      active.set(call.vesselId, {
        vesselId: call.vesselId,
        vesselName: call.vesselName,
        call,
        portId: call.portId,
        berthNo: call.berthNo,
        berthId: `${call.portId}-${call.berthNo}`,
        berthAt: call.time,
      });
    }
  }
  return active;
}

/** 把在港船舶状态按泊位归集，找出冲突泊位 */
export function groupStatesByBerth(states: Map<string, VesselInPortState>): {
  occupied: Map<string, VesselInPortState[]>;
  conflicts: BerthConflict[];
} {
  const occupied = new Map<string, VesselInPortState[]>();
  for (const state of states.values()) {
    const list = occupied.get(state.berthId) ?? [];
    list.push(state);
    occupied.set(state.berthId, list);
  }
  const conflicts: BerthConflict[] = [];
  for (const [berthId, list] of occupied) {
    if (list.length >= 2) {
      list.sort((a, b) => callTimeKey(a.call) - callTimeKey(b.call));
      conflicts.push({
        portId: list[0].portId,
        berthNo: list[0].berthNo,
        berthId,
        states: list,
      });
    }
  }
  conflicts.sort((a, b) => a.berthId.localeCompare(b.berthId));
  return { occupied, conflicts };
}

function sameOccupancy(a: Berth, b: BerthComputed): boolean {
  if (a.status === '维修' || b.status === '维修') return a.status === b.status;
  // 升级核对只关心「哪个泊位停了哪条船」是否一致；靠泊时间以流水为准直接更新，
  // 不把同船同泊位的时间漂移误报成占用不符（演示数据里该差值可达 1～2 小时）。
  return a.status === b.status && (a.vesselId ?? null) === (b.vesselId ?? null);
}

/** 固定 id 规则：同一问题在多次重算 / 升级间复用同一条核对单 */
function stableReviewId(kind: ReviewKind, key: string): string {
  return `rv-${kind}-${key}`;
}

/**
 * 以流水重算全部泊位占用，并产出 / 刷新待核对单。
 * 纯函数，不触碰数据库，便于在 Dexie 升级事务与日常更正中共用。
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { ports, berths, calls } = input;
  const mode = input.mode ?? 'reconcile';
  const nowIso = input.nowIso ?? new Date().toISOString();

  const berthById = new Map(berths.map((b) => [b.id, b]));
  const states = computeVesselStates(calls);
  const { occupied, conflicts } = groupStatesByBerth(states);
  const conflictById = new Map(conflicts.map((c) => [c.berthId, c]));

  const missingBerthCalls: PortCall[] = [];
  for (const state of states.values()) {
    if (!berthById.has(state.berthId)) missingBerthCalls.push(state.call);
  }
  const unknownPortCalls = calls.filter((c) => !c.portId || !c.berthNo);

  // —— 重算每个泊位 ——
  const nextBerths = berths.map((berth) => {
    const list = occupied.get(berth.id);
    // 维修是人工状态，不被流水重算覆盖
    if (berth.status === '维修') {
      return {
        ...berth,
        candidateVesselIds: [],
        candidateCallIds: [],
      } satisfies Berth;
    }
    if (!list || list.length === 0) {
      return {
        ...berth,
        status: '空闲',
        vesselId: null,
        vesselName: null,
        berthAt: null,
        leaveAt: null,
        candidateVesselIds: [],
        candidateCallIds: [],
      } satisfies Berth;
    }
    if (list.length === 1) {
      const s = list[0];
      return {
        ...berth,
        status: '占用',
        vesselId: s.vesselId,
        vesselName: s.vesselName,
        berthAt: s.berthAt,
        leaveAt: null,
        candidateVesselIds: [],
        candidateCallIds: [],
      } satisfies Berth;
    }
    // ≥2 条在港记录冲突：列待核对，泊位先显示最近靠泊的一条
    const latest = list[list.length - 1];
    return {
      ...berth,
      status: '待核对',
      vesselId: latest.vesselId,
      vesselName: latest.vesselName,
      berthAt: latest.berthAt,
      leaveAt: null,
      candidateVesselIds: list.map((s) => s.vesselId),
      candidateCallIds: list.map((s) => s.call.id),
    } satisfies Berth;
  });

  // —— 待核对单：复用既有单据，问题消失自动核销，人工结论不被覆盖 ——
  const existing = input.existingReviews ?? [];
  const reviews: OccupancyReview[] = [];
  const reuseKeys = new Set<string>();

  function reuseOrCreate(
    kind: ReviewKind,
    key: string,
    patch: Omit<OccupancyReview, 'id' | 'kind' | 'status' | 'createdAt' | 'resolvedAt' | 'resolution'> &
      Partial<Pick<OccupancyReview, 'detail'>>,
    opts: { keepResolved?: boolean } = {},
  ): void {
    const id = stableReviewId(kind, key);
    const old = existing.find((r) => r.id === id);
    reuseKeys.add(id);
    if (old) {
      // 人工核对结论默认保留；但泊位冲突以「当前是否仍冲突」为准——更正后冲突再现时要重新挂起，
      // 否则泊位显示待核对却没有可处理的核对单
      if (old.status === '待核对' || opts.keepResolved === false) {
        reviews.push({
          ...old,
          ...patch,
          id,
          kind,
          status: '待核对' as const,
          resolvedAt: null,
          resolution: null,
          createdAt: old.createdAt,
        });
      } else {
        reviews.push(old);
      }
    } else {
      reviews.push({
        id,
        kind,
        status: '待核对',
        createdAt: nowIso,
        resolvedAt: null,
        resolution: null,
        ...patch,
      });
    }
  }

  // 1) 泊位冲突：冲突当前存在即待核对，不沿用旧的已核对结论（冲突再现会重新挂起）
  for (const conflict of conflicts) {
    const portName = ports.find((p) => p.id === conflict.portId)?.name ?? conflict.portId;
    reuseOrCreate(
      'berth-conflict',
      conflict.berthId,
      {
        portId: conflict.portId,
        berthNo: conflict.berthNo,
        berthId: conflict.berthId,
        callIds: conflict.states.map((s) => s.call.id),
        vesselNames: conflict.states.map((s) => s.vesselName),
        detail: `${portName} ${conflict.berthNo} 重算出 ${conflict.states.length} 条在港记录（${conflict.states
          .map((s) => s.vesselName)
          .join('、')}），请保留实际靠泊的一条。`,
        source: mode === 'migration' ? 'migration' : 'reconcile',
      },
      { keepResolved: false },
    );
  }

  // 2) 升级旧数据：旧泊位占用与流水重算结果对不上
  if (mode === 'migration') {
    for (const old of berths) {
      if (conflictById.has(old.id)) continue;
      const next = nextBerths.find((b) => b.id === old.id);
      if (!next) continue;
      const computed: BerthComputed = {
        status: next.status,
        vesselId: next.vesselId,
        vesselName: next.vesselName,
        berthAt: next.berthAt,
        leaveAt: next.leaveAt,
        candidateVesselIds: next.candidateVesselIds ?? [],
        candidateCallIds: next.candidateCallIds ?? [],
      };
      if (!sameOccupancy(old, computed)) {
        reuseOrCreate('occupancy-mismatch', old.id, {
          portId: old.portId,
          berthNo: old.berthNo,
          berthId: old.id,
          callIds: occupied.get(old.id)?.map((s) => s.call.id) ?? [],
          vesselNames: occupied.get(old.id)?.map((s) => s.vesselName) ?? [],
          previousStatus: old.status,
          previousVesselName: old.vesselName,
          detail:
            old.status === '维修'
              ? `泊位原标记为维修，流水重算结果为「${computed.status}」，请确认以哪个为准。`
              : `泊位原登记为「${old.status}${old.vesselName ? `·${old.vesselName}` : ''}」，按流水重算为「${computed.status}${
                  computed.vesselName ? `·${computed.vesselName}` : ''
                }」，请确认。`,
          source: 'migration',
        });
      }
    }
  }

  // 3) 在港流水找不到泊位记录
  for (const call of missingBerthCalls) {
    reuseOrCreate('berth-missing', call.id, {
      portId: call.portId,
      berthNo: call.berthNo,
      berthId: `${call.portId}-${call.berthNo}`,
      callIds: [call.id],
      vesselNames: [call.vesselName],
      detail: `${call.vesselName} 的进港流水指向 ${call.berthNo}，但该渔港没有此泊位，占用无法登记。`,
      source: mode === 'migration' ? 'migration' : 'reconcile',
    });
  }

  // 4) 旧流水缺渔港信息
  for (const call of unknownPortCalls) {
    reuseOrCreate('port-unknown', call.id, {
      portId: '',
      berthNo: call.berthNo,
      berthId: '',
      callIds: [call.id],
      vesselNames: [call.vesselName],
      detail: `${call.vesselName} 的历史流水只有泊位号 ${call.berthNo || '（空）'}，推断不出所属渔港，未参与占用重算。`,
      source: mode === 'migration' ? 'migration' : 'reconcile',
    });
  }

  // 未被本轮问题命中的旧单据：待核对的自动核销（问题已随更正消失），已核对的原样保留
  for (const old of existing) {
    if (reuseKeys.has(old.id)) continue;
    if (old.status === '待核对') {
      reviews.push({
        ...old,
        status: '已核对',
        resolvedAt: nowIso,
        resolution: old.resolution ?? '问题已随流水更正自动消除',
      });
    } else {
      reviews.push(old);
    }
  }

  reviews.sort((a, b) => {
    if (a.status !== b.status) return a.status === '待核对' ? -1 : 1;
    return a.berthId.localeCompare(b.berthId) || b.createdAt.localeCompare(a.createdAt);
  });

  return { berths: nextBerths, reviews, conflicts, missingBerthCalls, unknownPortCalls };
}

/**
 * 升级迁移时为旧流水推断所属渔港（泊位号在各港重复，同船线索优先于跨船线索）：
 * 1) 同船+同泊位号、泊位表标记为占用的记录唯一；2) 同船同泊位号的已知流水；
 * 3) 同船其他流水的唯一渔港；4) 渔船船籍港与渔港名称匹配；
 * 5) 泊位号全局唯一；6) 同泊位号（含跨船）已知港口全部一致；都不成立则返回空串（列 port-unknown）。
 * 迁移中多轮调用，直到一轮内没有新增推断为止。
 */
export function inferCallPortId(
  call: PortCall,
  allCalls: PortCall[],
  berths: Berth[],
  vessels: FishingVessel[] = [],
  ports: FishingPort[] = [],
): string {
  if (call.portId) return call.portId;

  // 同船线索优先：泊位号在各港重复，跨船的同泊位号几乎没有推断价值
  const ownCalls = allCalls.filter((c) => c.id !== call.id && c.vesselId === call.vesselId);

  if (call.berthNo) {
    // 1) 旧泊位占用记录：同船 + 同泊位号且标记占用的泊位唯一时，最强信号
    const occupiedHits = berths.filter(
      (b) => b.status === '占用' && b.vesselId === call.vesselId && b.berthNo === call.berthNo,
    );
    if (occupiedHits.length === 1) return occupiedHits[0].portId;

    // 2) 同船、同泊位号、已推断出港口的流水
    const ownSameBerth = new Set(ownCalls.filter((c) => c.berthNo === call.berthNo && c.portId).map((c) => c.portId));
    if (ownSameBerth.size === 1) return [...ownSameBerth][0];

    // 3) 同船其他流水已推断出唯一渔港
    const ownPorts = new Set(ownCalls.filter((c) => c.portId).map((c) => c.portId));
    if (ownPorts.size === 1) return [...ownPorts][0];
  } else {
    const ownPorts = new Set(ownCalls.filter((c) => c.portId).map((c) => c.portId));
    if (ownPorts.size === 1) return [...ownPorts][0];
  }

  // 4) 按渔船船籍港与渔港名称互相包含来猜（如「石塘」↔「温岭石塘渔港」）
  const homePort = vessels.find((v) => v.id === call.vesselId)?.homePort.trim();
  if (homePort) {
    const hits = ports.filter((p) => p.name.includes(homePort) || homePort.includes(p.name.replace(/渔港$/, '')));
    if (hits.length === 1) return hits[0].id;
  }

  if (call.berthNo) {
    // 5) 泊位号在全部泊位中只出现一次
    const berthHits = berths.filter((b) => b.berthNo === call.berthNo);
    if (berthHits.length === 1) return berthHits[0].portId;

    // 6) 同泊位号的流水（含跨船）已推断出的港口全部一致时才采用
    const sameBerthPorts = new Set(
      allCalls.filter((c) => c.id !== call.id && c.berthNo === call.berthNo && c.portId).map((c) => c.portId),
    );
    if (sameBerthPorts.size === 1) return [...sameBerthPorts][0];
  }
  return '';
}
