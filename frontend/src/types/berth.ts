/** 泊位状态 */
export type BerthStatus = '空闲' | '占用' | '维修' | '待核对';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修', '待核对'];

/** 泊位占用记录（占用 / 空闲 / 待核对 均由进出港流水重算得出，维修为人工状态） */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 占用渔船 id（待核对时为系统推断保留的一条） */
  vesselId: string | null;
  /** 占用渔船名 */
  vesselName: string | null;
  /** 靠泊时间（ISO 字符串） */
  berthAt: string | null;
  /** 离泊时间（ISO 字符串） */
  leaveAt: string | null;
  /** 状态：空闲 / 占用 / 维修 / 待核对 */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
  /** 待核对时关联的核对单 id */
  reviewId: string | null;
}

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 待核对泊位数量 */
  pending: number;
  /** 占用率 0-1（待核对不计入占用） */
  occupancyRate: number;
  /** 在港船舶数量 */
  inPortCount: number;
  freeBerths: Berth[];
  occupiedBerths: Berth[];
}
