<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  ElMessage,
  ElMessageBox,
  type FormInstance,
  type FormRules,
} from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import CallRevisions from '../components/common/CallRevisions.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import {
  CALL_TYPES,
  VISA_STATUSES,
  emptyCallDraft,
  type CallDraft,
  type PortCall,
} from '../types/call';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';

interface CallForm extends CallDraft {}

const router = useRouter();
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

/** 进港只能选空闲泊位；出港只能选已占用泊位；待核对泊位先去核对，不可直接登记 */
const berthOptions = computed(() => {
  const wanted = form.value.type === '进港' ? '空闲' : '占用';
  return portStore.berths
    .filter((b) => b.status === wanted)
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
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
// summary 用于占用率展示；待核对数从中取 pending
const { summary } = useBerthStatus(berthRef, computed(() => focusPortId.value));

const todayCalls = computed(() =>
  portStore.callsSorted.filter((c) => isToday(c.time) && !c.voided),
);
const ledgerCalls = computed(() => portStore.callsSorted);

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

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
  if (berth.status === '待核对') {
    ElMessage.warning('该泊位存在冲突的在港记录，请先到「待核对」处理');
    return;
  }
  if ((form.value.type === '进港' && berth.status !== '空闲') || (form.value.type === '出港' && berth.status !== '占用')) {
    ElMessage.warning(`${form.value.type} 只能选择${form.value.type === '进港' ? '空闲' : '已占用'}泊位`);
    return;
  }
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
  if (!portStore.berthAvailable(form.value.portId, form.value.berthNo, form.value.type)) {
    ElMessage.warning('该泊位当前状态不能登记此类型，请刷新确认或先处理待核对');
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
    const call = await portStore.registerCall(payload, selectedVessel.value.name);
    ElMessage.success(`已登记 ${call.vesselName} ${call.type} · 泊位 ${call.berthNo}，泊位占用已重算`);
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

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

/* ---------------- 流水更正 / 作废 ---------------- */

const editVisible = ref(false);
const editSubmitting = ref(false);
const editTarget = ref<PortCall | null>(null);
const editFormRef = ref<FormInstance>();
const editForm = ref<CallDraft & { reason: string }>({
  ...emptyCallDraft(),
  reason: '',
});

const editRules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
};

const editVessel = computed(() => vesselStore.vesselById(editForm.value.vesselId));

/** 更正时允许在任意在册泊位中重选（含被其它船占用的——正是点错泊位要修正的场景） */
const editBerthOptions = computed(() =>
  portStore.berths
    .filter((b) => b.status !== '维修')
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}（${b.status}）`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);

const editBerthKey = computed({
  get: () =>
    editForm.value.portId && editForm.value.berthNo ? `${editForm.value.portId}|${editForm.value.berthNo}` : '',
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    editForm.value.portId = portId ?? '';
    editForm.value.berthNo = berthNo ?? '';
  },
});

const editWasVisa = computed(() => editTarget.value?.visaStatus === '已签证');

function startEdit(call: PortCall): void {
  editTarget.value = call;
  editForm.value = {
    vesselId: call.vesselId,
    type: call.type,
    // ISO → datetime-local
    time: toLocalInput(call.time),
    portId: call.portId,
    berthNo: call.berthNo,
    iceKg: call.iceKg,
    fuelL: call.fuelL,
    unloadKg: call.unloadKg,
    visaStatus: call.visaStatus,
    reason: '',
  };
  editVisible.value = true;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function submitEdit(): Promise<void> {
  if (!editTarget.value || !editFormRef.value) return;
  const valid = await editFormRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!editVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  if (editWasVisa.value && !editForm.value.reason.trim()) {
    ElMessage.warning('已签证流水更正须填写更正原因，原样会保留在修订记录里');
    return;
  }
  editSubmitting.value = true;
  try {
    await portStore.correctCall(
      editTarget.value.id,
      {
        vesselId: editForm.value.vesselId,
        type: editForm.value.type,
        time: editForm.value.time,
        portId: editForm.value.portId,
        berthNo: editForm.value.berthNo,
        iceKg: Number(editForm.value.iceKg) || 0,
        fuelL: Number(editForm.value.fuelL) || 0,
        unloadKg: Number(editForm.value.unloadKg) || 0,
        visaStatus: editForm.value.visaStatus,
        reason: editForm.value.reason,
      },
      editVessel.value.name,
    );
    ElMessage.success('流水已更正，相关泊位占用已重算');
    editVisible.value = false;
  } catch (error) {
    ElMessage.error(`更正失败：${(error as Error).message}`);
  } finally {
    editSubmitting.value = false;
  }
}

async function voidCall(call: PortCall): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `作废后「${call.vesselName} ${call.type} · 泊位 ${call.berthNo}」不再参与泊位重算，且无需再补冲抵流水。${
        call.visaStatus === '已签证' ? '该流水已签证，作废操作会留痕。' : ''
      }`,
      '作废流水',
      {
        confirmButtonText: '确认作废',
        cancelButtonText: '取消',
        inputPlaceholder: '作废原因（已签证必填）',
        inputValidator: (v: string) => (call.visaStatus === '已签证' && !v?.trim() ? '已签证流水作废须填写原因' : true),
      },
    );
    await portStore.voidCall(call.id, value ?? '');
    ElMessage.success('流水已作废，泊位占用已重算');
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(`作废失败：${(error as Error).message}`);
  }
}

async function restoreCall(call: PortCall): Promise<void> {
  await portStore.restoreCall(call.id);
  ElMessage.success('流水已恢复，泊位占用已重算');
}

function visaTagType(status: PortCall['visaStatus']): 'danger' | 'warning' | 'info' {
  if (status === '已签证') return 'danger';
  if (status === '待签证') return 'warning';
  return 'info';
}

function callPortName(call: PortCall): string {
  return portStore.portById(call.portId)?.name ?? '待核对归属';
}

function gotoReviews(): void {
  void router.push('/reviews');
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          选择渔船与进出港类型，填写泊位号、加冰量、加油量与卸货量，提交后自动同步泊位占用状态
        </p>
      </div>
      <el-button v-if="portStore.pendingReviewCount" type="danger" plain @click="gotoReviews">
        有 {{ portStore.pendingReviewCount }} 条泊位待核对，前往处理
      </el-button>
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
                :placeholder="form.type === '进港' ? '选择空闲泊位' : '选择已占用泊位'"
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
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
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
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }} · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }}<template v-if="summary.pending"> · <el-button text type="danger" size="small" @click="gotoReviews">待核对 {{ summary.pending }}</el-button></template>
          </p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <span class="card-title">今日流水（{{ todayCalls.length }} 条）</span>
      </template>
      <el-table :data="todayCalls" size="small" border empty-text="今日暂无进出港流水" data-testid="today-calls">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="渔港 / 泊位" min-width="150">
          <template #default="scope">{{ callPortName(scope.row) }} · {{ scope.row.berthNo }}</template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="签证" width="120">
          <template #default="scope">
            <el-tag size="small" :type="visaTagType(scope.row.visaStatus)" effect="plain">{{ scope.row.visaStatus }}</el-tag>
            <CallRevisions v-if="scope.row.revisions.length" :call="scope.row" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <div class="ledger-head">
          <span class="card-title">进出港流水台账（共 {{ ledgerCalls.filter((c) => !c.voided).length }} 条，含作废 {{ ledgerCalls.filter((c) => c.voided).length }} 条）</span>
          <span class="ledger-tip">点错船或泊位可直接「更正」，泊位占用随即重算，无需另补冲抵流水</span>
        </div>
      </template>
      <el-table :data="ledgerCalls" size="small" border data-testid="call-ledger" row-key="id">
        <el-table-column label="状态" width="84">
          <template #default="scope">
            <el-tag v-if="scope.row.voided" size="small" type="info" effect="plain">已作废</el-tag>
            <el-tag v-else size="small" :type="scope.row.type === '进港' ? 'primary' : 'success'">{{ scope.row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="vesselName" label="船名" min-width="120" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="渔港 / 泊位" min-width="150">
          <template #default="scope">{{ callPortName(scope.row) }} · {{ scope.row.berthNo }}</template>
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
        <el-table-column label="签证 / 留痕" min-width="150">
          <template #default="scope">
            <el-tag size="small" :type="visaTagType(scope.row.visaStatus)" effect="plain">{{ scope.row.visaStatus }}</el-tag>
            <CallRevisions v-if="scope.row.revisions.length" :call="scope.row" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button
              v-if="!scope.row.voided"
              text
              type="primary"
              size="small"
              data-testid="edit-call"
              @click="startEdit(scope.row)"
            >
              更正
            </el-button>
            <el-button v-if="!scope.row.voided" text type="danger" size="small" @click="voidCall(scope.row)">作废</el-button>
            <el-button v-else text type="success" size="small" @click="restoreCall(scope.row)">恢复</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 更正对话框 -->
    <el-dialog v-model="editVisible" title="更正进出港流水" width="620px" data-testid="edit-dialog">
      <el-alert
        v-if="editWasVisa"
        type="warning"
        show-icon
        :closable="false"
        title="该流水已签证：更正后当前值覆盖展示，更正前的原样会保存在修订记录中"
        class="edit-alert"
      />
      <el-form v-if="editTarget" ref="editFormRef" :model="editForm" :rules="editRules" label-width="110px">
        <el-form-item label="渔船" prop="vesselId">
          <el-select v-model="editForm.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
            <el-option
              v-for="v in vesselOptions"
              :key="v.id"
              :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
              :value="v.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="进出港类型" prop="type">
          <el-radio-group v-model="editForm.type">
            <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="时间" prop="time">
          <el-date-picker
            v-model="editForm.time"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="选择时间"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="渔港 / 泊位" prop="portId">
          <el-select v-model="editBerthKey" placeholder="选择实际渔港泊位" style="width: 100%" filterable>
            <el-option v-for="opt in editBerthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="加冰 kg" prop="iceKg">
              <el-input-number v-model="editForm.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="加油 L" prop="fuelL">
              <el-input-number v-model="editForm.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="卸货 kg" prop="unloadKg">
              <el-input-number v-model="editForm.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="签证状态" prop="visaStatus">
          <el-select v-model="editForm.visaStatus" style="width: 100%">
            <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editWasVisa" label="更正原因" required>
          <el-input v-model="editForm.reason" type="textarea" :rows="2" placeholder="如：点错泊位，实际停靠 B03" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" data-testid="submit-edit" @click="submitEdit">
          保存更正并重算
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
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
.ledger-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.ledger-tip {
  font-size: 12px;
  color: #90a0b0;
  font-weight: 400;
}
.edit-alert {
  margin-bottom: 14px;
}
</style>
