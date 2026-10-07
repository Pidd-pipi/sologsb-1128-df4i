import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { OccupancyReview } from '../types/review';
import { buildBerthRecords } from './berth';
import { inferCallPortId, reconcile } from './reconcile';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录。
 * v4：流水以 portId+berthNo 锚定泊位、支持更正留底；新增 occupancy_reviews 表；
 *     泊位占用改为按全部流水重算，旧数据里对不上的列成待核对。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  reviews!: Table<OccupancyReview, string>;

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
        calls: 'id, vesselId, portId, type, time, berthNo',
        berths: 'id, portId, berthNo, status, vesselId',
        reviews: 'id, status, kind, portId, berthId, source',
      })
      .upgrade(async (tx) => {
        const callTable = tx.table<PortCall, string>('calls');
        const berthTable = tx.table<Berth, string>('berths');
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const vessels = await tx.table<FishingVessel, string>('vessels').toArray();
        const vesselNameById = new Map(vessels.map((v) => [v.id, v.name]));

        let berths = await berthTable.toArray();
        // 为新建渔港（理论上 v3 已补齐，兜底）生成泊位
        for (const port of ports) {
          const exists = berths.some((b) => b.portId === port.id);
          if (!exists) {
            const built = buildBerthRecords(port);
            await berthTable.bulkPut(built);
            berths = berths.concat(built);
          }
        }

        // 1) 旧流水补齐字段；portId 多轮推断（占用记录→同船流水→船籍港→泊位号），
        //    推断不出的留空（reconcile 时列 port-unknown 待核对）
        const calls = await callTable.toArray();
        const normalized = calls.map((call) => ({
          ...call,
          vesselName: call.vesselName || vesselNameById.get(call.vesselId) || '',
          // 已有 portId 的保留，没有的从零推断
          portId: call.portId ?? '',
          revisions: Array.isArray(call.revisions) ? call.revisions : [],
          correctedAt: call.correctedAt ?? null,
          excludedFromOccupancy: Boolean(call.excludedFromOccupancy),
          iceKg: Number(call.iceKg) || 0,
          fuelL: Number(call.fuelL) || 0,
          unloadKg: Number(call.unloadKg) || 0,
        }));
        // 多轮推断：先吃下确定信息（占用记录、唯一泊位），再据此消解同船 / 同泊位歧义，
        // 直到一轮中没有新增推断为止
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const call of normalized) {
            if (call.portId) continue;
            const guessed = inferCallPortId(call, normalized, berths, vessels, ports);
            if (guessed) {
              call.portId = guessed;
              progressed = true;
            }
          }
        }
        await callTable.clear();
        await callTable.bulkPut(normalized);

        // 2) 以流水重算泊位占用；旧值与重算结果对不上的列 occupancy-mismatch
        const result = reconcile({
          ports,
          berths,
          calls: normalized,
          existingReviews: [],
          mode: 'migration',
        });
        await berthTable.clear();
        await berthTable.bulkPut(result.berths);
        await tx.table<OccupancyReview, string>('reviews').bulkPut(result.reviews);
      });
  }
}

export const db = new FishPortDatabase();
