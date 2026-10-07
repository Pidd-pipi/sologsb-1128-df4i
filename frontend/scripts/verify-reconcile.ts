import { reconcile, computeVesselStates, inferCallPortId } from '../src/db/reconcile';
import { buildBerthRecords } from '../src/db/berth';
import { SEED_PORTS, SEED_CALLS } from '../src/db/seed';
import type { Berth } from '../src/types/berth';
import type { PortCall } from '../src/types/call';
import type { FishingPort } from '../src/types/port';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}

function mkCall(p: Partial<PortCall> & Pick<PortCall, 'id' | 'vesselId' | 'vesselName' | 'type' | 'time' | 'portId' | 'berthNo'>): PortCall {
  return {
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: p.time,
    ...p,
  } as PortCall;
}

// 演示数据：v3 建出的泊位（占用已写入）
const seedBerths: Berth[] = SEED_PORTS.flatMap((p: FishingPort) => buildBerthRecords(p));

console.log('1) 演示数据迁移：一致时不应产生待核对单');
{
  const r = reconcile({ ports: SEED_PORTS as FishingPort[], berths: seedBerths, calls: SEED_CALLS, mode: 'migration' });
  check('无待核对单', r.reviews.length === 0, `got ${r.reviews.length}: ${r.reviews.map((x) => x.kind).join(',')}`);
  const b01p1 = r.berths.find((b) => b.id === 'p-1001-B01')!;
  check('p-1001 B01 占用 v-2001', b01p1.status === '占用' && b01p1.vesselId === 'v-2001');
  const b02p2 = r.berths.find((b) => b.id === 'p-1002-B02')!;
  check('p-1002 B02 占用 v-2006（出港后又有进港）', b02p2.status === '占用' && b02p2.vesselId === 'v-2006');
  const b04p1 = r.berths.find((b) => b.id === 'p-1001-B04')!;
  check('维修状态保留', b04p1.status === '维修');
}

console.log('2) 更正流水：船从 B01 改到 B03，旧泊位释放、新泊位占用');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  // 先按迁移重算一次，再更正 c-3001（v-2001 的进港）到 B03
  const migrated = reconcile({ ports: SEED_PORTS as FishingPort[], berths, calls: SEED_CALLS, mode: 'migration' });
  const changed: PortCall[] = SEED_CALLS.map((c) =>
    c.id === 'c-3001' ? { ...c, portId: 'p-1001', berthNo: 'B03' } : c,
  );
  const r = reconcile({
    ports: SEED_PORTS as FishingPort[],
    berths: migrated.berths,
    calls: changed,
    existingReviews: migrated.reviews,
  });
  const b01 = r.berths.find((b) => b.id === 'p-1001-B01')!;
  const b03 = r.berths.find((b) => b.id === 'p-1001-B03')!;
  check('B01 已释放为空闲', b01.status === '空闲' && b01.vesselId === null, JSON.stringify(b01));
  check('B03 变为占用 v-2001', b03.status === '占用' && b03.vesselId === 'v-2001', JSON.stringify(b03));
  check('无待核对单', r.reviews.length === 0);
}

console.log('3) 冲突：两船在同一泊位在港 → 待核对泊位 + berth-conflict 核对单');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  const calls: PortCall[] = [
    mkCall({ id: 'a', vesselId: 'ship-a', vesselName: '甲船', type: '进港', time: iso(5), portId: 'p-1001', berthNo: 'B01' }),
    mkCall({ id: 'b', vesselId: 'ship-b', vesselName: '乙船', type: '进港', time: iso(2), portId: 'p-1001', berthNo: 'B01' }),
  ];
  const r = reconcile({ ports: SEED_PORTS as FishingPort[], berths, calls });
  const b01 = r.berths.find((x) => x.id === 'p-1001-B01')!;
  check('B01 状态为待核对', b01.status === '待核对', b01.status);
  check('候选两条', b01.candidateVesselIds?.length === 2, JSON.stringify(b01.candidateVesselIds));
  check('一条 berth-conflict 待核对', r.reviews.length === 1 && r.reviews[0].kind === 'berth-conflict' && r.reviews[0].status === '待核对');
  check('显示最近靠泊的乙船', b01.vesselName === '乙船');

  // 值班员保留甲船：乙船流水标记 excludedFromOccupancy
  const afterKeep = calls.map((c) => ({ ...c, excludedFromOccupancy: c.id === 'b' }));
  const r2 = reconcile({
    ports: SEED_PORTS as FishingPort[],
    berths: r.berths,
    calls: afterKeep,
    existingReviews: r.reviews.map((rv) =>
      rv.kind === 'berth-conflict'
        ? { ...rv, status: '已核对' as const, resolvedAt: iso(0), resolution: '保留甲船' }
        : rv,
    ),
  });
  const b01after = r2.berths.find((x) => x.id === 'p-1001-B01')!;
  check('保留后 B01 占用甲船', b01after.status === '占用' && b01after.vesselId === 'ship-a', JSON.stringify(b01after));
  check('冲突消失后已核对单保持已核对', r2.reviews.every((x) => x.status === '已核对'));

  // 值班员又把乙船那条流水更正回 B01 → 冲突再现，旧已核对单应重新挂起
  const reintroduced = afterKeep.map((c) => (c.id === 'b' ? { ...c, excludedFromOccupancy: false } : c));
  const r3 = reconcile({
    ports: SEED_PORTS as FishingPort[],
    berths: r2.berths,
    calls: reintroduced,
    existingReviews: r2.reviews,
  });
  const reopened = r3.reviews.find((x) => x.kind === 'berth-conflict');
  check('冲突再现时已核对单重新挂起', reopened?.status === '待核对', reopened?.status ?? 'no review');
  const b01again = r3.berths.find((x) => x.id === 'p-1001-B01')!;
  check('B01 重新变为待核对', b01again.status === '待核对');
}

console.log('4) 冲突随补登出港自动消除：待核对单据自动核销');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  const calls: PortCall[] = [
    mkCall({ id: 'a', vesselId: 'ship-a', vesselName: '甲船', type: '进港', time: iso(5), portId: 'p-1001', berthNo: 'B01' }),
    mkCall({ id: 'b', vesselId: 'ship-b', vesselName: '乙船', type: '进港', time: iso(2), portId: 'p-1001', berthNo: 'B01' }),
  ];
  const r = reconcile({ ports: SEED_PORTS as FishingPort[], berths, calls });
  check('先有冲突', r.conflicts.length === 1);
  const fixed = [...calls, mkCall({ id: 'c', vesselId: 'ship-a', vesselName: '甲船', type: '出港', time: iso(1), portId: 'p-1001', berthNo: 'B01' })];
  const r2 = reconcile({ ports: SEED_PORTS as FishingPort[], berths: r.berths, calls: fixed, existingReviews: r.reviews });
  const b01 = r2.berths.find((x) => x.id === 'p-1001-B01')!;
  check('冲突消除后 B01 占用乙船', b01.status === '占用' && b01.vesselId === 'ship-b', JSON.stringify(b01));
  check('旧待核对单自动核销', r2.reviews.length === 1 && r2.reviews[0].status === '已核对', JSON.stringify(r2.reviews));
}

console.log('5) 升级旧数据：泊位旧值与流水对不上 → occupancy-mismatch');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  // 旧数据：B05 被人工登记为占用甲船，但没有任何进港流水
  const withGhost = berths.map((b) =>
    b.id === 'p-1001-B05' ? { ...b, status: '占用' as const, vesselId: 'ship-x', vesselName: '幽灵船', berthAt: iso(9) } : b,
  );
  const r = reconcile({
    ports: SEED_PORTS as FishingPort[],
    berths: withGhost,
    calls: [mkCall({ id: 'z', vesselId: 'ship-y', vesselName: '别的船', type: '出港', time: iso(3), portId: 'p-1004', berthNo: 'B01' })],
    mode: 'migration',
  });
  const rv = r.reviews.find((x) => x.kind === 'occupancy-mismatch' && x.berthId === 'p-1001-B05');
  check('幽灵占用列 occupancy-mismatch', Boolean(rv), r.reviews.map((x) => x.kind + '@' + x.berthId).join(';'));
  const b05 = r.berths.find((x) => x.id === 'p-1001-B05')!;
  check('泊位已按流水重算为空闲', b05.status === '空闲');
  check('保留旧值信息 previousVesselName', rv?.previousVesselName === '幽灵船');
}

console.log('6) 旧流水缺 portId：能推断则补齐，推断不出列 port-unknown');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  const known: PortCall[] = [
    mkCall({ id: 'k1', vesselId: 'ship-a', vesselName: '甲船', type: '进港', time: iso(9), portId: 'p-1001', berthNo: 'B01' }),
  ];
  const missing: PortCall = mkCall({ id: 'k2', vesselId: 'ship-a', vesselName: '甲船', type: '出港', time: iso(8), portId: '', berthNo: 'B01' });
  check('同船唯一渔港可推断', inferCallPortId(missing, [missing, ...known], berths) === 'p-1001');

  const lonely: PortCall = mkCall({ id: 'x1', vesselId: 'ship-z', vesselName: '孤船', type: '进港', time: iso(9), portId: '', berthNo: 'B99' });
  check('无法推断返回空串', inferCallPortId(lonely, [lonely], berths) === '');

  const r = reconcile({
    ports: SEED_PORTS as FishingPort[],
    berths,
    calls: [lonely],
    mode: 'migration',
  });
  check('列 port-unknown 待核对', r.reviews.some((x) => x.kind === 'port-unknown' && x.status === '待核对'));
}

console.log('7) 流水指向不存在的泊位 → berth-missing');
{
  const berths = SEED_PORTS.flatMap((p) => buildBerthRecords(p));
  const calls: PortCall[] = [
    mkCall({ id: 'm', vesselId: 'ship-a', vesselName: '甲船', type: '进港', time: iso(1), portId: 'p-1004', berthNo: 'B99' }),
  ];
  const r = reconcile({ ports: SEED_PORTS as FishingPort[], berths, calls });
  check('列 berth-missing', r.reviews.some((x) => x.kind === 'berth-missing'));
  check('missingBerthCalls 命中', r.missingBerthCalls.length === 1);
}

console.log('8) excludedFromOccupancy 的流水不参与占用');
{
  const states = computeVesselStates([
    mkCall({ id: 'a', vesselId: 's', vesselName: '甲', type: '进港', time: iso(2), portId: 'p-1001', berthNo: 'B01' }),
    mkCall({ id: 'b', vesselId: 's', vesselName: '甲', type: '进港', time: iso(1), portId: 'p-1001', berthNo: 'B01', excludedFromOccupancy: true } as PortCall),
  ]);
  // 两条都不排除会是同一船（map 按船聚合），这里验证被排除的不影响状态
  check('状态推导正常', states.get('s')?.call.id === 'a');
}

process.exit(failures ? 1 : 0);
