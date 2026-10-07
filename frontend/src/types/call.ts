/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 更正留痕：已签证流水被更正时，保存更正前的原样 */
export interface CallRevision {
  /** 更正时间（ISO 字符串） */
  at: string;
  /** 更正前的字段原样（仅记录被涉及的字段） */
  snapshot: Partial<{
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
    /** 作废留痕时记录的旧作废状态（原为 false） */
    voided?: boolean;
  }>;
  /** 更正原因 / 备注 */
  reason: string;
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
  /** 所属渔港 id（v4 起补齐；历史数据推断不出时为空串，进入待核对） */
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
  /** 是否作废（冲抵 / 核对舍弃的流水不删除，只标记作废） */
  voided: boolean;
  /** 更正留痕，最近一次更正排在末尾 */
  revisions: CallRevision[];
  createdAt: string;
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

/** 更正表单模型（与登记一致，另带更正原因） */
export type CallCorrection = CallDraft & { reason: string };
