<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import OccupancyReviewPanel from '../components/common/OccupancyReviewPanel.vue';
import CallCorrectionDialog from '../components/common/CallCorrectionDialog.vue';
import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import { CALL_TYPES, VISA_STATUSES, emptyCallDraft, type CallDraft, type CallType } from '../types/call';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';

interface CallForm extends CallDraft {}

const portStore = usePortStore();
const vesselStore = useVesselStore();

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  time: nowLocalInputValue(),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/**
 * 进港选空闲泊位；待核对泊位也允许登记（重算后继续挂核对单）。
 * 出港可选占用或待核对泊位 —— 待核对泊位上的船离港后，冲突可能随之消除。
 */
const berthOptions = computed(() => {
  const allowed = form.value.type === '进港' ? ['空闲', '待核对'] : ['占用', '待核对'];
  return portStore.berths
    .filter((b) => allowed.includes(b.status))
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}${b.status === '待核对' ? '（待核对）' : ''}`,
      portId: b.portId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
});

const berthKey = computed({
  get: () => (form.value.portId && form.value.berthNo ? `${form.value.portId}|${form.value.berthNo}` : ''),
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    form.value.portId = portId ?? '';
    form.value.berthNo = berthNo ?? '';
    focusPortId.value = portId ?? '';
  },
});

const focusBerths = computed<Berth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

const scopeToday = ref(true);
const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));
const tableCalls = computed(() => (scopeToday.value ? todayCalls.value : portStore.callsSorted));

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

// —— 流水更正弹窗 ——
const correctVisible = ref(false);
const correctingCall = ref<PortCall | null>(null);

function openCorrection(callId: string): void {
  const call = portStore.callById(callId);
  if (!call) return;
  correctingCall.value = call;
  correctVisible.value = true;
}

function onCorrected(): void {
  // 重算后若产生冲突，待核对面板会自动出现；此处给出一次提示
  if (portStore.pendingReviews.length) {
    ElMessage.warning('重算后仍有泊位存在冲突在港记录，请在「待核对」中保留一条');
  }
}

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.berthNo) ||
    Number(value.iceKg) > 0 ||
    Number(value.fuelL) > 0 ||
    Number(value.unloadKg) > 0
  );
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (restore()) {
    if (hasContent(form.value)) {
      ElMessage.info(`已恢复本地草稿（保存于 ${formatDateTime(savedAt.value)}）`);
    } else {
      // 空草稿没有恢复价值，直接清掉，避免误报「已恢复草稿」
      clearDraft();
    }
  }
  if (form.value.portId) focusPortId.value = form.value.portId;
});

watch(
  () => toPlain(form.value),
  (value) => {
    // 只有存在有效输入时才落草稿；提交后表单被重置，草稿同步清空
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch(
  () => form.value.type,
  () => {
    const valid = berthOptions.value.some((opt) => opt.value === berthKey.value);
    if (!valid) berthKey.value = '';
  },
);

function selectBerth(berth: Berth): void {
  berthKey.value = `${berth.portId}|${berth.berthNo}`;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  submitting.value = true;
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      portId: form.value.portId,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
    };
    const call = await portStore.registerCall(payload, selectedVessel.value.name, form.value.portId);
    ElMessage.success(`已登记 ${call.vesselName} ${call.type} · 泊位 ${call.berthNo}`);
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      time: nowLocalInputValue(),
    });
    focusPortId.value = '';
  } catch (error) {
    ElMessage.error(`登记失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          选择渔船与进出港类型，填写泊位号、加冰量、加油量与卸货量；流水提交或更正后泊位占用自动重算，两处不再各留旧值
        </p>
      </div>
    </header>

    <el-alert
      v-if="restored"
      type="info"
      show-icon
      :closable="false"
      title="已从浏览器本地草稿恢复未提交的表单"
      data-testid="draft-alert"
      class="draft-alert"
    >
      <template #default>
        草稿保存在 localStorage（键 {{ storageKey }}），提交成功后会清空。
      </template>
    </el-alert>

    <OccupancyReviewPanel v-if="portStore.pendingReviews.length" @correct="openCorrection" />

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="call-vessel" v-model="form.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="时间" prop="time">
              <el-date-picker
                id="call-time"
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="选择时间"
                style="width: 100%"
              />
            </el-form-item>

            <el-form-item label="泊位号" prop="portId">
              <el-select
                id="call-berth"
                v-model="berthKey"
                :placeholder="form.type === '进港' ? '选择空闲泊位' : '选择占用 / 待核对泊位'"
                style="width: 100%"
                data-testid="call-berth"
              >
                <el-option v-for="opt in berthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="加冰 kg" prop="iceKg">
                  <el-input-number id="call-ice" v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="加油 L" prop="fuelL">
                  <el-input-number id="call-fuel" v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="卸货量 kg" prop="unloadKg">
                  <el-input-number id="call-unload" v-model="form.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="签证状态" prop="visaStatus">
              <el-select id="call-visa" v-model="form.visaStatus" style="width: 100%">
                <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="submitting" data-testid="submit-call" @click="submit">保存登记</el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计</span>
          </template>
          <div class="stat-row">
            <div class="stat"><span class="stat__label">进港</span><b>{{ todayStats.inbound }}</b></div>
            <div class="stat"><span class="stat__label">出港</span><b>{{ todayStats.outbound }}</b></div>
            <div class="stat"><span class="stat__label">加冰 kg</span><b>{{ formatNumber(todayStats.ice, 0) }}</b></div>
            <div class="stat"><span class="stat__label">加油 L</span><b>{{ formatNumber(todayStats.fuel, 0) }}</b></div>
            <div class="stat"><span class="stat__label">卸货 kg</span><b>{{ formatNumber(todayStats.unload, 0) }}</b></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              泊位占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '（选择泊位后聚焦对应渔港）' }}
            </span>
          </template>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" />
          <EmptyState v-else title="尚未选择渔港泊位" description="在左侧表单选择泊位，或直接点击泊位网格中的方块。">
            <el-button type="primary" @click="focusPortId = portStore.ports[0]?.id ?? ''">聚焦第一座渔港</el-button>
          </EmptyState>
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }}
            <template v-if="summary.pending"> · <b class="hint-danger">待核对 {{ summary.pending }}</b></template>
            · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }}
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <div class="table-head">
          <span class="card-title">进出港流水</span>
          <el-radio-group v-model="scopeToday" size="small">
            <el-radio-button :value="true">今日（{{ todayCalls.length }}）</el-radio-button>
            <el-radio-button :value="false" data-testid="scope-all">全部（{{ portStore.callsSorted.length }}）</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-table :data="tableCalls" size="small" border empty-text="暂无进出港流水" data-testid="calls-table">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位" min-width="150">
          <template #default="scope">
            {{ portStore.portById(scope.row.portId)?.name ?? '未知渔港' }} · {{ scope.row.berthNo }}
          </template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="签证 / 状态" min-width="150">
          <template #default="scope">
            <el-tag size="small" :type="scope.row.visaStatus === '已签证' ? 'success' : 'info'">
              {{ scope.row.visaStatus }}
            </el-tag>
            <el-tag v-if="scope.row.revisions?.length" size="small" type="warning" effect="plain" class="inline-tag">
              已更正 {{ scope.row.revisions.length }}
            </el-tag>
            <el-tag v-if="scope.row.excludedFromOccupancy" size="small" type="danger" effect="plain" class="inline-tag">
              不参与占用
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="scope">
            <el-button text type="primary" size="small" data-testid="correct-call" @click="openCorrection(scope.row.id)">
              更正
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <CallCorrectionDialog
      v-model="correctVisible"
      :call="correctingCall"
      @corrected="onCorrected"
    />
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.draft-alert {
  border-radius: 10px;
}
.stat-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: #7b8a99;
}
.stat b {
  font-size: 18px;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.hint-danger {
  color: #f56c6c;
}
.table-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.inline-tag {
  margin-left: 4px;
}
</style>
