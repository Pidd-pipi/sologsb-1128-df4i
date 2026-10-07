import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallCorrection, CallDraft, CallRevision, PortCall } from '../types/call';
import type { ReviewIssue } from '../types/review';
import { buildBerthRecords } from '../db/berth';
import { replayOccupancy } from '../services/occupancy';

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

/** 更正时需要原样留痕的字段 */
const TRACKED_FIELDS = [
  'vesselId',
  'vesselName',
  'type',
  'time',
  'portId',
  'berthNo',
  'iceKg',
  'fuelL',
  'unloadKg',
  'visaStatus',
] as const;

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const reviews = ref<ReviewIssue[]>([]);
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
  const pendingReviewCount = computed(() => pendingReviews.value.length);

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

  function reviewById(id: string): ReviewIssue | undefined {
    return reviews.value.find((r) => r.id === id);
  }

  /** 某泊位当前是否允许登记（进港要空闲、出港要占用），待核对泊位不可直接登记 */
  function berthAvailable(portId: string, berthNo: string, type: PortCall['type']): boolean {
    const berth = berths.value.find((b) => b.portId === portId && b.berthNo === berthNo);
    if (!berth) return false;
    return type === '进港' ? berth.status === '空闲' : berth.status === '占用';
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
      reviewId: null,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  /**
   * 人工设置泊位状态。维修 / 取消维修是人工状态，会在流水重算中保留；
   * 直接置空闲属于临时处置，下一次流水变更重算时仍以流水为准。
   */
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
      reviewId: status === '维修' ? null : hit.reviewId,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
    // 维修 / 取消维修后都以流水重算一遍：维修是唯一保留的人工状态，其余仍以流水为准
    await applyReplay(calls.value);
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /** 以全部流水为事实来源重算泊位与核对单，并事务化落库 */
  async function applyReplay(nextCalls: PortCall[]): Promise<void> {
    const now = new Date().toISOString();
    const { berths: nextBerths, reviews: nextReviews } = replayOccupancy({
      calls: nextCalls,
      berths: berths.value,
      reviews: reviews.value,
      now,
    });
    await db.transaction('rw', db.calls, db.berths, db.reviews, async () => {
      await db.berths.bulkPut(toPlain(nextBerths));
      await db.reviews.bulkPut(toPlain(nextReviews));
    });
    berths.value = nextBerths;
    reviews.value = nextReviews;
  }

  /**
   * 登记一条进出港记录，并以流水重算泊位占用（进港 → 占用，出港 → 释放）。
   */
  async function registerCall(draft: CallDraft, vesselName: string): Promise<PortCall> {
    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : new Date().toISOString(),
      portId: draft.portId,
      berthNo: draft.berthNo,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      voided: false,
      revisions: [],
      createdAt: new Date().toISOString(),
    };
    const nextCalls = [...calls.value, call];
    await db.calls.put(toPlain(call));
    calls.value = nextCalls;
    await applyReplay(nextCalls);
    return call;
  }

  /**
   * 更正已登记的进出港流水（点错船 / 点错泊位 / 时间或数量填错）。
   * 已签证流水必须保留更正前原样：把涉及字段的旧值写入 revisions；其余状态直接覆盖。
   * 更正后以流水为准重算相关泊位，不再各留旧值。
   */
  async function correctCall(callId: string, correction: CallCorrection, vesselName: string): Promise<PortCall> {
    const hit = callById(callId);
    if (!hit) throw new Error('流水不存在');
    if (hit.voided) throw new Error('已作废的流水不能更正，请恢复后再改');

    const next: PortCall = {
      ...hit,
      vesselId: correction.vesselId,
      vesselName,
      type: correction.type,
      time: correction.time ? new Date(correction.time).toISOString() : hit.time,
      portId: correction.portId,
      berthNo: correction.berthNo,
      iceKg: Number(correction.iceKg) || 0,
      fuelL: Number(correction.fuelL) || 0,
      unloadKg: Number(correction.unloadKg) || 0,
      visaStatus: correction.visaStatus,
    };

    if (hit.visaStatus === '已签证') {
      const snapshot = {} as CallRevision['snapshot'];
      for (const field of TRACKED_FIELDS) {
        if (field === 'vesselName') {
          if (hit.vesselName !== vesselName) snapshot.vesselName = hit.vesselName;
        } else if (hit[field] !== next[field]) {
          (snapshot as Record<string, unknown>)[field] = hit[field];
        }
      }
      // 更换渔船时，旧船名随旧 vesselId 一并留痕
      if (snapshot.vesselId && !snapshot.vesselName) snapshot.vesselName = hit.vesselName;
      next.revisions = [
        ...hit.revisions,
        { at: new Date().toISOString(), snapshot, reason: correction.reason.trim() || '值班员更正' },
      ];
    }

    const nextCalls = calls.value.map((c) => (c.id === callId ? next : c));
    await db.calls.put(toPlain(next));
    calls.value = nextCalls;
    await applyReplay(nextCalls);
    return next;
  }

  /** 作废流水（替代另补一条冲抵流水的旧做法；冲抵/核对舍弃都走作废，不物理删除） */
  async function voidCall(callId: string, reason: string): Promise<void> {
    const hit = callById(callId);
    if (!hit || hit.voided) return;
    const next: PortCall = { ...hit, voided: true };
    if (hit.visaStatus === '已签证') {
      const revision: CallRevision = {
        at: new Date().toISOString(),
        snapshot: { voided: false },
        reason: reason || '作废冲抵',
      };
      next.revisions = [...hit.revisions, revision];
    }
    const nextCalls = calls.value.map((c) => (c.id === callId ? next : c));
    await db.calls.put(toPlain(next));
    calls.value = nextCalls;
    await applyReplay(nextCalls);
  }

  /** 恢复误作废的流水 */
  async function restoreCall(callId: string): Promise<void> {
    const hit = callById(callId);
    if (!hit || !hit.voided) return;
    const nextCalls = calls.value.map((c) => (c.id === callId ? { ...c, voided: false } : c));
    await db.calls.put(toPlain(nextCalls.find((c) => c.id === callId)!));
    calls.value = nextCalls;
    await applyReplay(nextCalls);
  }

  /**
   * 处理泊位冲突核对单：值班员保留 keepCallId 这一条进港流水，其余候选作废后重算。
   */
  async function resolveBerthConflict(reviewId: string, keepCallId: string): Promise<void> {
    const review = reviewById(reviewId);
    if (!review || review.kind !== '泊位冲突' || review.status !== '待核对') return;
    if (!review.callIds.includes(keepCallId)) throw new Error('保留的流水不在候选中');
    const now = new Date().toISOString();

    const nextCalls = calls.value.map((c) => {
      if (!review.callIds.includes(c.id) || c.id === keepCallId || c.voided) return c;
      return { ...c, voided: true as const };
    });
    const nextReviews = reviews.value.map((r) =>
      r.id === reviewId
        ? {
            ...r,
            status: '已处理' as const,
            resolvedAt: now,
            resolution: `值班员保留流水 ${keepCallId}，其余候选作废`,
          }
        : r,
    );

    const { berths: nextBerths, reviews: replayed } = replayOccupancy({
      calls: nextCalls,
      berths: berths.value,
      reviews: nextReviews,
      now,
    });
    await db.transaction('rw', db.calls, db.berths, db.reviews, async () => {
      await db.calls.bulkPut(toPlain(nextCalls));
      await db.berths.bulkPut(toPlain(nextBerths));
      await db.reviews.bulkPut(toPlain(replayed));
    });
    calls.value = nextCalls;
    berths.value = nextBerths;
    reviews.value = replayed;
  }

  /**
   * 处理流水归属核对单：给升级时推断不出渔港的旧流水补挂渔港，随后重算泊位。
   */
  async function assignCallPort(reviewId: string, portId: string): Promise<void> {
    const review = reviewById(reviewId);
    if (!review || review.kind !== '流水归属' || review.status !== '待核对') return;
    const callId = review.callIds[0];
    const now = new Date().toISOString();

    const nextCalls = calls.value.map((c) => (c.id === callId ? { ...c, portId } : c));
    const nextReviews = reviews.value.map((r) =>
      r.id === reviewId
        ? {
            ...r,
            status: '已处理' as const,
            portId,
            resolvedAt: now,
            resolution: `补挂渔港 ${portId} 后重算`,
          }
        : r,
    );

    const { berths: nextBerths, reviews: replayed } = replayOccupancy({
      calls: nextCalls,
      berths: berths.value,
      reviews: nextReviews,
      now,
    });
    await db.transaction('rw', db.calls, db.berths, db.reviews, async () => {
      await db.calls.bulkPut(toPlain(nextCalls));
      await db.berths.bulkPut(toPlain(nextBerths));
      await db.reviews.bulkPut(toPlain(replayed));
    });
    calls.value = nextCalls;
    berths.value = nextBerths;
    reviews.value = replayed;
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
    pendingReviewCount,
    portById,
    berthsOf,
    callsOfVessel,
    callById,
    reviewById,
    berthAvailable,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    correctCall,
    voidCall,
    restoreCall,
    resolveBerthConflict,
    assignCallPort,
  };
});
