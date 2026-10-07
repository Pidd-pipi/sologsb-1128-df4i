import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { ReviewIssue } from '../types/review';
import { buildBerthRecords } from './berth';
import { inferCallPortId, replayOccupancy } from '../services/occupancy';
import { uid } from '../utils/format';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 流水补 portId / voided / revisions，新增 reviews 核对单表，并以流水为唯一事实来源全量重算泊位占用。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  reviews!: Table<ReviewIssue, string>;

  constructor() {
    super('gbfishport-db');

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        calls: 'id, vesselId, type, time, portId, voided',
        berths: 'id, portId, berthNo, status, vesselId',
        reviews: 'id, kind, status, portId, berthNo',
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString();
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const vessels = await tx.table<FishingVessel, string>('vessels').toArray();
        const calls = await tx.table<PortCall, string>('calls').toArray();
        const berths = await tx.table<Berth, string>('berths').toArray();
        const callTable = tx.table<PortCall, string>('calls');
        const berthTable = tx.table<Berth, string>('berths');
        const reviewTable = tx.table<ReviewIssue, string>('reviews');

        // 1) 规整历史流水新字段，并推断所属渔港
        const knownByVessel = new Map<string, string>();
        const normalized: PortCall[] = calls.map((call) => ({
          ...call,
          portId: '',
          voided: false,
          revisions: [],
        }));

        // 多轮推断：后推断出的归属可帮助同船的其它流水
        let remaining = normalized.filter((c) => !c.portId);
        for (let round = 0; round < 3 && remaining.length; round += 1) {
          const stillMissing: PortCall[] = [];
          for (const call of remaining) {
            const portId = inferCallPortId(call, {
              ports,
              berths,
              vessels,
              knownCallsByVessel: knownByVessel,
            });
            if (portId) {
              call.portId = portId;
              if (!knownByVessel.has(call.vesselId)) knownByVessel.set(call.vesselId, portId);
            } else {
              stillMissing.push(call);
            }
          }
          remaining = stillMissing;
        }

        // 2) 仍无法归属的旧流水：列成「流水归属」待核对
        const newReviews: ReviewIssue[] = [];
        for (const call of remaining) {
          newReviews.push({
            id: uid('r'),
            kind: '流水归属',
            status: '待核对',
            portId: '',
            berthNo: call.berthNo,
            callIds: [call.id],
            detail: `历史流水「${call.vesselName} ${call.type} · 泊位 ${call.berthNo}」无法确定所属渔港，请补挂后重算。`,
            createdAt: now,
            resolvedAt: null,
            resolution: '',
          });
        }

        // 3) 以流水为唯一事实来源重算泊位占用；旧泊位表里对不上的值不再保留
        const legacyReviews = await reviewTable.toArray();
        const { berths: nextBerths, reviews: nextReviews } = replayOccupancy({
          calls: normalized,
          berths: berths.map((b) => ({ ...b, reviewId: null })),
          reviews: [...legacyReviews, ...newReviews],
          now,
        });

        await callTable.clear();
        await callTable.bulkPut(normalized);
        await berthTable.clear();
        await berthTable.bulkPut(nextBerths);
        await reviewTable.clear();
        await reviewTable.bulkPut(nextReviews);
      });
  }
}

export const db = new FishPortDatabase();
