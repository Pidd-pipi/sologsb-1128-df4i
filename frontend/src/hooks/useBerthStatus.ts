import { computed, type ComputedRef, type Ref } from 'vue';
import type { Berth, BerthSummary } from '../types/berth';

export interface UseBerthStatus {
  scope: ComputedRef<Berth[]>;
  summary: ComputedRef<BerthSummary>;
  inPortVessels: ComputedRef<Berth[]>;
  freeBerths: ComputedRef<Berth[]>;
  summaryOf: (portId: string) => BerthSummary;
  occupancyRateOf: (portId: string) => number;
}

function summarize(portId: string, list: Berth[]): BerthSummary {
  const total = list.length;
  const occupied = list.filter((b) => b.status === '占用').length;
  const maintenance = list.filter((b) => b.status === '维修').length;
  const pending = list.filter((b) => b.status === '待核对').length;
  const free = total - occupied - maintenance - pending;
  // 待核对泊位的候选船也算在港（尚未人工剔除前仍停在港内），但不计入占用率
  const pendingCandidates = list.reduce(
    (sum, b) => (b.status === '待核对' ? sum + Math.max(b.candidateVesselIds?.length ?? 1, 1) : sum),
    0,
  );
  return {
    portId,
    total,
    occupied,
    free,
    maintenance,
    pending,
    occupancyRate: total === 0 ? 0 : occupied / total,
    inPortCount: occupied + pendingCandidates,
    freeBerths: list.filter((b) => b.status === '空闲'),
    occupiedBerths: list.filter((b) => b.status === '占用'),
    pendingBerths: list.filter((b) => b.status === '待核对'),
  };
}

/**
 * 聚合泊位占用与在港船舶数量，输出占用率与空闲泊位列表。
 * @param berths 泊位响应式数据源（一般来自 portStore）
 * @param portId 需要聚焦的渔港 id；不传则对全部泊位聚合
 */
export function useBerthStatus(berths: Ref<Berth[]>, portId?: Ref<string> | string): UseBerthStatus {
  const roomId = computed(() => (typeof portId === 'string' ? portId : portId?.value ?? ''));

  const scope = computed(() => {
    const id = roomId.value;
    const list = id ? berths.value.filter((b) => b.portId === id) : [...berths.value];
    return list.sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  });

  const summary = computed<BerthSummary>(() => summarize(roomId.value, scope.value));
  const inPortVessels = computed(() =>
    scope.value.filter((b) => (b.status === '占用' || b.status === '待核对') && b.vesselName),
  );
  const freeBerths = computed(() => scope.value.filter((b) => b.status === '空闲'));

  function summaryOf(id: string): BerthSummary {
    return summarize(
      id,
      berths.value.filter((b) => b.portId === id),
    );
  }

  function occupancyRateOf(id: string): number {
    return summaryOf(id).occupancyRate;
  }

  return { scope, summary, inPortVessels, freeBerths, summaryOf, occupancyRateOf };
}
