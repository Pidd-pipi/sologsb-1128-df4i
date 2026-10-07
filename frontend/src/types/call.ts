/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 更正前的原样快照（已签证流水更正后必须留底） */
export interface CallRevision {
  /** 更正时间（ISO 字符串） */
  at: string;
  /** 更正人（值班员，当前应用无登录体系，固定为“值班员”） */
  by: string;
  /** 更正原因 */
  reason: string;
  vesselId: string;
  vesselName: string;
  type: CallType;
  time: string;
  portId: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

/** 进出港记录 */
export interface PortCall {
  id: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 所属渔港 id（v4 起补齐；老数据迁移时推断，推断不出列入待核对） */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  /**
   * 是否被值班员在「待核对」中排除（不参与泊位占用重算，流水仍保留可查）。
   * 同一泊位两条在港记录冲突时，保留的一条继续参与重算，另一条置为 true。
   */
  excludedFromOccupancy?: boolean;
  /** 更正留底：最近更正排在最前；已签证流水更正后至少有一条 */
  revisions?: CallRevision[];
  createdAt: string;
  /** 最近更正时间（ISO 字符串），未更正过为 null */
  correctedAt?: string | null;
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  portId: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

export function emptyCallDraft(berthNo = '', portId = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    portId,
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
  };
}

/** 判定一条流水更正前是否需要留底（已签证流水必须留下原样） */
export function requiresRevisionSnapshot(call: PortCall): boolean {
  return call.visaStatus === '已签证';
}
