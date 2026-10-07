import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import {
  type CallDraft,
  type CallRevision,
  type PortCall,
} from '../types/call';
import type { OccupancyReview } from '../types/review';
import { buildBerthRecords } from '../db/berth';
import { reconcile } from '../db/reconcile';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

/** 更正流水时提交的内容（含更正原因） */
export interface CallCorrection extends CallDraft {
  reason: string;
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const reviews = ref<OccupancyReview[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  const pendingReviews = computed(() => reviews.value.filter((r) => r.status === '待核对'));

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function callById(id: string): PortCall | undefined {
    return calls.value.find((c) => c.id === id);
  }

  function reviewById(id: string): OccupancyReview | undefined {
    return reviews.value.find((r) => r.id === id);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, r] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.reviews.toArray(),
      ]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
      reviews.value = r;
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    // 新增泊位后可能正好对上流水里引用不到的泊位，重算一次并核销对应待核对单
    await recomputeFromCalls();
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
      candidateVesselIds: status === '待核对' ? hit.candidateVesselIds : [],
      candidateCallIds: status === '待核对' ? hit.candidateCallIds : [],
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 以全部流水重算泊位占用、刷新待核对单。
   * 流水是唯一事实源：同一条靠泊在泊位与流水两处都有记录，流水一改这里就重算，
   * 泊位上不再单独保留会过期的旧值。
   * 在 db.transaction 内调用时必须传入 txCalls（事务内读取到的最新流水），
   * 且不能再开启新事务（Dexie 事务不可重入）。
   */
  async function recomputeFromCalls(txCalls?: PortCall[]): Promise<void> {
    const latestCalls = txCalls ?? (await db.calls.toArray());
    const [latestBerths, latestReviews, latestPorts] = await Promise.all([
      db.berths.toArray(),
      db.reviews.toArray(),
      db.ports.toArray(),
    ]);
    const result = reconcile({
      ports: latestPorts,
      berths: latestBerths,
      calls: latestCalls,
      existingReviews: latestReviews,
      mode: 'reconcile',
    });
    await db.berths.bulkPut(toPlain(result.berths));
    await db.reviews.bulkPut(toPlain(result.reviews));
    berths.value = result.berths;
    reviews.value = result.reviews;
    if (!txCalls) calls.value = latestCalls;
  }

  /**
   * 登记一条进出港记录，并立即按流水重算泊位占用
   * （进港 → 占用，出港 → 释放；重算后若同一泊位出现两条冲突在港记录，自动列待核对）。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : new Date().toISOString(),
      portId,
      berthNo: draft.berthNo,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      excludedFromOccupancy: false,
      revisions: [],
      correctedAt: null,
      createdAt: new Date().toISOString(),
    };
    const plain = toPlain(call);
    await db.transaction('rw', db.calls, db.berths, db.reviews, db.ports, async () => {
      await db.calls.put(plain);
      const nextCalls = await db.calls.toArray();
      await recomputeFromCalls(nextCalls);
    });
    calls.value = [...calls.value, call];
    return call;
  }

  /**
   * 更正已登记的进出港流水。
   * 已签证流水更正后，原样以快照形式留在 revisions（所有更正均留底，已签证为强制要求）；
   * 更正提交后泊位占用整体重算，泊位与流水不再各留旧值。
   */
  async function correctCall(callId: string, correction: CallCorrection): Promise<PortCall | null> {
    const original = callById(callId);
    if (!original) return null;
    // 改选渔船时，船名以渔船档案为准；档案缺失则沿用原船名
    const vesselName =
      correction.vesselId === original.vesselId
        ? original.vesselName
        : (await db.vessels.get(correction.vesselId))?.name ?? original.vesselName;
    const next: PortCall = {
      ...original,
      vesselId: correction.vesselId,
      vesselName,
      type: correction.type,
      time: correction.time ? new Date(correction.time).toISOString() : original.time,
      portId: correction.portId,
      berthNo: correction.berthNo,
      iceKg: Number(correction.iceKg) || 0,
      fuelL: Number(correction.fuelL) || 0,
      unloadKg: Number(correction.unloadKg) || 0,
      visaStatus: correction.visaStatus,
      correctedAt: new Date().toISOString(),
    };
    const snapshot: CallRevision = {
      at: new Date().toISOString(),
      by: '值班员',
      reason: correction.reason.trim() || '更正错选的渔船 / 泊位',
      vesselId: original.vesselId,
      vesselName: original.vesselName,
      type: original.type,
      time: original.time,
      portId: original.portId,
      berthNo: original.berthNo,
      iceKg: original.iceKg,
      fuelL: original.fuelL,
      unloadKg: original.unloadKg,
      visaStatus: original.visaStatus,
    };
    next.revisions = [snapshot, ...(original.revisions ?? [])];
    // 更正后重新参与占用重算（若该条此前在冲突核对中被排除过）
    next.excludedFromOccupancy = false;

    const plain = toPlain(next);
    await db.transaction('rw', db.calls, db.berths, db.reviews, db.ports, async () => {
      await db.calls.put(plain);
      const nextCalls = await db.calls.toArray();
      await recomputeFromCalls(nextCalls);
    });
    calls.value = calls.value.map((c) => (c.id === callId ? next : c));
    return next;
  }

  /**
   * 待核对：同一泊位两条在港记录冲突时，值班员保留其中一条。
   * 另一条流水打上 excludedFromOccupancy（流水保留可查，不再参与占用），泊位按保留项重算。
   */
  async function resolveBerthConflictKeep(reviewId: string, keptCallId: string): Promise<void> {
    const review = reviewById(reviewId);
    if (!review || review.kind !== 'berth-conflict') return;
    const now = new Date().toISOString();
    const kept = callById(keptCallId);
    await db.transaction('rw', db.calls, db.berths, db.reviews, db.ports, async () => {
      let nextCalls = await db.calls.toArray();
      nextCalls = nextCalls.map((c) =>
        review.callIds.includes(c.id)
          ? { ...c, excludedFromOccupancy: c.id !== keptCallId }
          : c,
      );
      await db.calls.bulkPut(toPlain(nextCalls));
      const resolved: OccupancyReview = {
        ...review,
        status: '已核对',
        resolvedAt: now,
        resolution: `保留 ${kept?.vesselName ?? keptCallId} 的在港记录，其余流水标记为不参与占用`,
      };
      await db.reviews.put(toPlain(resolved));
      calls.value = nextCalls;
      reviews.value = reviews.value.map((r) => (r.id === reviewId ? resolved : r));
      await recomputeFromCalls(nextCalls);
    });
  }

  /**
   * 待核对：确认两条记录都不算在港（泊位置空）。
   */
  async function resolveBerthConflictEmpty(reviewId: string): Promise<void> {
    const review = reviewById(reviewId);
    if (!review || review.kind !== 'berth-conflict') return;
    const now = new Date().toISOString();
    await db.transaction('rw', db.calls, db.berths, db.reviews, db.ports, async () => {
      let nextCalls = await db.calls.toArray();
      nextCalls = nextCalls.map((c) =>
        review.callIds.includes(c.id) ? { ...c, excludedFromOccupancy: true } : c,
      );
      await db.calls.bulkPut(toPlain(nextCalls));
      const resolved: OccupancyReview = {
        ...review,
        status: '已核对',
        resolvedAt: now,
        resolution: '核对确认该泊位当前无在港船舶，相关进港流水均不参与占用',
      };
      await db.reviews.put(toPlain(resolved));
      calls.value = nextCalls;
      reviews.value = reviews.value.map((r) => (r.id === reviewId ? resolved : r));
      await recomputeFromCalls(nextCalls);
    });
  }

  /**
   * 待核对：升级旧数据时泊位占用与流水对不上（occupancy-mismatch），
   * 值班员确认按流水重算结果为准 —— 重算结果已在 reconcile 时落到泊位，这里只需核销。
   */
  async function resolveReviewAcceptFlow(reviewId: string): Promise<void> {
    const review = reviewById(reviewId);
    if (!review) return;
    const now = new Date().toISOString();
    const nextCalls = await db.calls.toArray();
    await db.transaction('rw', db.calls, db.berths, db.reviews, db.ports, async () => {
      const resolved: OccupancyReview = {
        ...review,
        status: '已核对',
        resolvedAt: now,
        resolution:
          review.kind === 'occupancy-mismatch'
            ? '确认以进出港流水重算结果为准'
            : '已知悉并核对该问题，按当前流水状态处理',
      };
      await db.reviews.put(toPlain(resolved));
      reviews.value = reviews.value.map((r) => (r.id === reviewId ? resolved : r));
      // 再重算一次（值班员可能已在期间更正过流水，或新增了泊位）
      await recomputeFromCalls(nextCalls);
    });
  }

  return {
    ports,
    berths,
    calls,
    reviews,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    pendingReviews,
    portById,
    berthsOf,
    callsOfVessel,
    callById,
    reviewById,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    recomputeFromCalls,
    registerCall,
    correctCall,
    resolveBerthConflictKeep,
    resolveBerthConflictEmpty,
    resolveReviewAcceptFlow,
  };
});
