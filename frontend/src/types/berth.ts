/** 泊位状态 */
export type BerthStatus = '空闲' | '占用' | '维修' | '待核对';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修', '待核对'];

/** 泊位占用记录 */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 占用渔船 id（待核对时取最近一条进港的渔船，最终由值班员核对） */
  vesselId: string | null;
  /** 占用渔船名 */
  vesselName: string | null;
  /** 靠泊时间（ISO 字符串） */
  berthAt: string | null;
  /** 离泊时间（ISO 字符串） */
  leaveAt: string | null;
  /** 状态：空闲 / 占用 / 维修 / 待核对（同一泊位重算出两条冲突在港记录时） */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
  /** 待核对时，重算命中的全部在港渔船 id（1 条即正常占用，≥2 条冲突） */
  candidateVesselIds?: string[];
  /** 待核对时，命中的在港流水 id */
  candidateCallIds?: string[];
}

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 待核对泊位数（同一泊位存在冲突在港记录） */
  pending: number;
  /** 占用率 0-1（仅按“占用”计，待核对不计入占用率分子） */
  occupancyRate: number;
  /** 在港船舶数量（占用泊位；待核对泊位按候选船数计入） */
  inPortCount: number;
  freeBerths: Berth[];
  occupiedBerths: Berth[];
  pendingBerths: Berth[];
}
