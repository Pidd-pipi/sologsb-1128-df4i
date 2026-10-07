import type { BerthStatus } from './berth';

/** 待核对类型 */
export type ReviewKind =
  /** 同一泊位重算出两条（及以上）冲突的在港记录，需值班员挑一条保留 */
  | 'berth-conflict'
  /** 升级旧数据时，泊位占用与流水重算结果对不上 */
  | 'occupancy-mismatch'
  /** 流水引用了不存在的泊位 / 渔港，无法参与重算 */
  | 'berth-missing'
  /** 旧流水缺港口信息，推断不出所属渔港 */
  | 'port-unknown';

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  'berth-conflict': '泊位在港记录冲突',
  'occupancy-mismatch': '泊位占用与流水不符',
  'berth-missing': '流水泊位不存在',
  'port-unknown': '流水缺少渔港信息',
};

/** 待核对状态 */
export type ReviewStatus = '待核对' | '已核对';

/**
 * 泊位占用 / 流水核对单。
 * 升级时发现对不上的旧数据、以及重算后出现的冲突，都先列成待核对，
 * 由值班员在登记页挑一条保留（或确认按流水重算结果）。
 */
export interface OccupancyReview {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  /** 关联渔港 id（port-unknown 时为空串） */
  portId: string;
  /** 关联泊位号（port-unknown 时为空串） */
  berthNo: string;
  /** 泊位主键 `${portId}-${berthNo}`，便于索引（port-unknown 时为空串） */
  berthId: string;
  /** 冲突 / 涉及的流水 id（berth-conflict 时有 ≥2 条） */
  callIds: string[];
  /** 涉及渔船名（冗余，便于列表展示） */
  vesselNames: string[];
  /** 发现该问题时记录的旧泊位状态（升级核对用） */
  previousStatus?: BerthStatus | null;
  /** 旧泊位上的渔船名（升级核对用） */
  previousVesselName?: string | null;
  /** 说明 */
  detail: string;
  /** 问题来源：migration = 升级旧数据；reconcile = 流水改动后重算 */
  source: 'migration' | 'reconcile';
  createdAt: string;
  /** 核对时间 */
  resolvedAt?: string | null;
  /** 核对方式 */
  resolution?: string | null;
}
