<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import type { ReviewIssue } from '../types/review';
import { formatDateTime, formatNumber } from '../utils/format';

const router = useRouter();
const portStore = usePortStore();

const loaded = ref(false);
/** 每个冲突单当前选中要保留的流水 id */
const keptByReview = ref<Record<string, string>>({});
/** 流水归属单补挂的渔港 id */
const portByReview = ref<Record<string, string>>({});
const processing = ref<Record<string, boolean>>({});

const pending = computed(() => portStore.pendingReviews);
const conflicts = computed(() => pending.value.filter((r) => r.kind === '泊位冲突'));
const orphanCalls = computed(() => pending.value.filter((r) => r.kind === '流水归属'));
const resolved = computed(() =>
  portStore.reviews
    .filter((r) => r.status === '已处理')
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')),
);

/** 各渔港是否含某泊位号，供补挂下拉提示 */
function portHasBerth(portId: string, berthNo: string | undefined): boolean {
  if (!berthNo) return false;
  return portStore.berthsOf(portId).some((b) => b.berthNo === berthNo);
}

function portName(portId: string): string {
  return portStore.portById(portId)?.name ?? portId ?? '—';
}

function candidateCalls(review: ReviewIssue): PortCall[] {
  return review.callIds
    .map((id) => portStore.callById(id))
    .filter((c): c is PortCall => Boolean(c) && !c!.voided)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function orphanCall(review: ReviewIssue): PortCall | undefined {
  return portStore.callById(review.callIds[0]);
}

function keptCall(review: ReviewIssue): PortCall | undefined {
  const id = keptByReview.value[review.id];
  return candidateCalls(review).find((c) => c.id === id);
}

async function keepCandidate(review: ReviewIssue): Promise<void> {
  const keepId = keptByReview.value[review.id];
  if (!keepId) {
    ElMessage.warning('请先勾选要保留的一条进港流水');
    return;
  }
  processing.value[review.id] = true;
  try {
    await portStore.resolveBerthConflict(review.id, keepId);
    ElMessage.success('已按保留流水重算泊位占用');
    delete keptByReview.value[review.id];
  } catch (error) {
    ElMessage.error(`核对失败：${(error as Error).message}`);
  } finally {
    processing.value[review.id] = false;
  }
}

async function assignPort(review: ReviewIssue): Promise<void> {
  const portId = portByReview.value[review.id];
  if (!portId) {
    ElMessage.warning('请先选择该流水所属渔港');
    return;
  }
  processing.value[review.id] = true;
  try {
    await portStore.assignCallPort(review.id, portId);
    ElMessage.success('已补挂渔港并重算泊位占用');
    delete portByReview.value[review.id];
  } catch (error) {
    ElMessage.error(`补挂失败：${(error as Error).message}`);
  } finally {
    processing.value[review.id] = false;
  }
}

/** 冲突单可跳转去更正规整（如两条其实是同船重复登记，可到流水里作废一条） */
function gotoCalls(): void {
  void router.push('/calls');
}

onMounted(async () => {
  if (!portStore.ports.length || !portStore.calls.length) await portStore.loadAll();
  loaded.value = true;
});
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>泊位占用待核对</h1>
        <p class="page__sub">
          流水更正后重算，同一泊位出现两条冲突的在港记录、或升级时归属不明的历史流水，都列在这里，由值班员核对处理
        </p>
      </div>
    </header>

    <el-alert
      v-if="loaded && !pending.length"
      type="success"
      show-icon
      :closable="false"
      title="没有待核对项，泊位占用与流水一致"
      data-testid="review-empty"
      class="review-alert"
    />

    <!-- 泊位冲突 -->
    <el-card
      v-for="review in conflicts"
      :key="review.id"
      shadow="never"
      class="detail-card"
      data-testid="review-conflict"
    >
      <template #header>
        <div class="review-head">
          <el-tag type="danger" effect="dark">泊位冲突</el-tag>
          <span class="review-title">{{ portName(review.portId) }} · 泊位 {{ review.berthNo }}</span>
          <span class="review-time">列单于 {{ formatDateTime(review.createdAt) }}</span>
        </div>
      </template>

      <p class="review-detail">{{ review.detail }}</p>

      <el-table :data="candidateCalls(review)" size="small" border class="review-table" @row-click="(row: PortCall) => (keptByReview[review.id] = row.id)">
        <el-table-column width="55" align="center">
          <template #default="scope">
            <el-radio v-model="keptByReview[review.id]" :value="scope.row.id" data-testid="keep-radio">
              <span></span>
            </el-radio>
          </template>
        </el-table-column>
        <el-table-column prop="vesselName" label="船名" min-width="120" />
        <el-table-column label="进港时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="泊位号" width="80" />
        <el-table-column label="加冰 kg" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证" width="90" />
      </el-table>

      <div class="review-actions">
        <el-button
          type="primary"
          :loading="!!processing[review.id]"
          :disabled="!keptCall(review)"
          data-testid="resolve-conflict"
          @click="keepCandidate(review)"
        >
          保留「{{ keptCall(review)?.vesselName ?? '请选择' }}」，其余作废并重算
        </el-button>
        <el-button text type="primary" @click="gotoCalls">去流水里更正 / 作废</el-button>
      </div>
    </el-card>

    <!-- 流水归属 -->
    <el-card
      v-for="review in orphanCalls"
      :key="review.id"
      shadow="never"
      class="detail-card"
      data-testid="review-orphan"
    >
      <template #header>
        <div class="review-head">
          <el-tag type="warning" effect="dark">流水归属</el-tag>
          <span class="review-title">升级旧数据 · 归属不明</span>
          <span class="review-time">列单于 {{ formatDateTime(review.createdAt) }}</span>
        </div>
      </template>

      <p class="review-detail">{{ review.detail }}</p>

      <el-table v-if="orphanCall(review)" :data="[orphanCall(review)]" size="small" border class="review-table">
        <el-table-column prop="vesselName" label="船名" min-width="120" />
        <el-table-column prop="type" label="类型" width="70" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column prop="berthNo" label="泊位号" width="80" />
        <el-table-column prop="visaStatus" label="签证" width="90" />
      </el-table>

      <div class="review-actions review-actions--inline">
        <el-select
          v-model="portByReview[review.id]"
          placeholder="选择该流水实际所属渔港"
          style="width: 320px"
          data-testid="assign-port"
        >
          <el-option
            v-for="p in portStore.ports"
            :key="p.id"
            :label="`${p.name}（泊位 ${orphanCall(review)?.berthNo ?? ''}：${portHasBerth(p.id, orphanCall(review)?.berthNo) ? '有' : '无'}）`"
            :value="p.id"
          />
        </el-select>
        <el-button
          type="primary"
          :loading="!!processing[review.id]"
          :disabled="!portByReview[review.id]"
          data-testid="resolve-orphan"
          @click="assignPort(review)"
        >
          补挂渔港并重算
        </el-button>
      </div>
    </el-card>

    <!-- 处理记录 -->
    <el-card v-if="resolved.length" shadow="never" class="detail-card">
      <template #header><span class="card-title">已处理记录（{{ resolved.length }}）</span></template>
      <el-timeline>
        <el-timeline-item
          v-for="r in resolved"
          :key="r.id"
          :timestamp="formatDateTime(r.resolvedAt)"
          placement="top"
          :type="r.kind === '泊位冲突' ? 'danger' : 'warning'"
        >
          <div class="resolved-row">
            <el-tag size="small" :type="r.kind === '泊位冲突' ? 'danger' : 'warning'">{{ r.kind }}</el-tag>
            <span>{{ portName(r.portId) }}<template v-if="r.berthNo"> · 泊位 {{ r.berthNo }}</template></span>
            <span class="resolved-note">{{ r.resolution }}</span>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <EmptyState
      v-else-if="loaded && !pending.length"
      title="暂无已处理的核对记录"
      description="出现冲突或归属不明的流水时，会在这里留下处理痕迹。"
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
.review-alert {
  border-radius: 10px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 4px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.review-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.review-title {
  font-weight: 600;
  color: #17324d;
}
.review-time {
  margin-left: auto;
  font-size: 12px;
  color: #8592a0;
}
.review-detail {
  margin: 0 0 12px;
  font-size: 13px;
  color: #5b6b7b;
}
.review-table {
  margin-bottom: 12px;
}
.review-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.resolved-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.resolved-note {
  color: #8592a0;
}
</style>
