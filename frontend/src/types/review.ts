import type { PortCall } from './call';

/** 待核对类型：泊位在港流水冲突 / 历史流水归属渔港无法确定 */
export type ReviewKind = '泊位冲突' | '流水归属';

export const REVIEW_KINDS: ReviewKind[] = ['泊位冲突', '流水归属'];

/** 核对单状态 */
export type ReviewStatus = '待核对' | '已处理';

/**
 * 待核对单。
 * - 泊位冲突：同一泊位重放后出现两条不同渔船的未闭合进港流水，由值班员保留一条。
 * - 流水归属：升级旧数据时无法推断某条流水的所属渔港，需补挂渔港后重算。
 */
export interface ReviewIssue {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  /** 泊位冲突：渔港 id；流水归属：补挂前为空 */
  portId: string;
  /** 泊位冲突：泊位号 */
  berthNo: string;
  /** 相关流水 id（泊位冲突为候选进港流水；流水归属为单条缺归属流水） */
  callIds: string[];
  /** 描述，便于值班员判断 */
  detail: string;
  createdAt: string;
  resolvedAt: string | null;
  /** 处理方式说明（保留 / 作废 / 补挂渔港） */
  resolution: string;
}

/** 泊位冲突核对单附带的候选流水视图 */
export interface ConflictCandidate {
  call: PortCall;
  vesselName: string;
  time: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: PortCall['visaStatus'];
}
