<script setup lang="ts">
/**
 * 资料室侧：/datum-room 统一基面折算定线室。
 * - 按测流当时的水尺零点把点据水尺读数折到统一基面后再定线，比测偏差与判定跟着重算；
 * - 零点改动后只重算未定案定线；已定案报出版本只读留档、原样可查；
 * - 重算失败只落在任务上，从这里重试；站上的水尺接测记录不参与重算写入。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentChecked, Refresh, View } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import { useDatumStore, type DatumLineRow } from '@/stores/datumStore'
import { useSurveyStore } from '@/stores/surveyStore'
import type { RatingVersion } from '@/types/ratingVersion'
import { initDatabase } from '@/utils/db'

const datumStore = useDatumStore()
const surveyStore = useSurveyStore()

onMounted(async () => {
  await initDatabase()
  surveyStore.start()
  datumStore.start()
  // 自动执行待处理重算；失败任务不自动重跑，由资料室显式重试
  await datumStore.runPending()
})

const publishDialogVisible = ref(false)
const publishTargetLine = ref<DatumLineRow | null>(null)
const publishForm = reactive({ note: '', operator: '林昭' })
const busy = ref(false)
const detailVersion = ref<RatingVersion | null>(null)
const detailVisible = ref(false)

const lineRows = computed(() => datumStore.lineRows)
const pendingJobs = computed(() => datumStore.pendingJobs)
const failedJobs = computed(() => datumStore.failedJobs)
const unmatchedCount = computed(() => surveyStore.unmatchedRatings.length)
const versionCount = computed(() => datumStore.versions.length)

function statusTagType(status: string): 'success' | 'warning' | 'info' {
  return status === 'finalized' ? 'success' : status === 'draft' ? 'warning' : 'info'
}
function statusLabel(status: string): string {
  return status === 'finalized' ? '已定案报出' : '未定案（工作稿）'
}
function jobTagType(status: string): 'warning' | 'primary' | 'success' | 'danger' {
  if (status === 'pending') return 'warning'
  if (status === 'running') return 'primary'
  if (status === 'succeeded') return 'success'
  return 'danger'
}
const jobStatusLabel: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '已成功',
  failed: '失败可重试'
}

async function runPending(): Promise<void> {
  busy.value = true
  try {
    await datumStore.runPending()
    ElMessage.success('待处理重算任务已执行完毕')
  } finally {
    busy.value = false
  }
}

async function recalc(row: DatumLineRow): Promise<void> {
  busy.value = true
  try {
    await datumStore.recalcLine(row.lineNo, row.stationId)
    ElMessage.success(`${row.lineNo} 线已按最新零点折算并重算`)
  } finally {
    busy.value = false
  }
}

async function retryJob(jobId: string): Promise<void> {
  busy.value = true
  try {
    // 重算事务不写 gaugeSurveys：站上接测记录不受重算成败影响
    await datumStore.retryJob(jobId)
    const job = datumStore.jobs.find((item) => item.id === jobId)
    if (job?.status === 'succeeded') ElMessage.success('重试成功，定线与比测已按统一基面重算')
    else ElMessage.warning(job?.errorMessage || '重试仍未成功，可再次重试（站上接测记录未受影响）')
  } finally {
    busy.value = false
  }
}

async function armFailure(): Promise<void> {
  const target = lineRows.value.find((row) => row.lineNo === 'A') ?? lineRows.value[0]
  if (!target) {
    ElMessage.warning('还没有定线，无法演练')
    return
  }
  await datumStore.armFailure(target.lineNo, target.stationId)
  ElMessage.info(`已让 ${target.lineNo} 线下一次重算强制失败，到任务表点「重试」即可恢复，站上接测记录不受影响`)
}

function openPublish(row: DatumLineRow): void {
  if (!row.fit.valid) {
    ElMessage.warning('当前工作稿定线无效，无法定案报出')
    return
  }
  if (row.unmatchedCount > 0) {
    ElMessage.warning(`还有 ${row.unmatchedCount} 个点据待站上认零点，全部折好后再定案`)
    return
  }
  publishTargetLine.value = row
  publishForm.note = `${row.lineNo} 线按统一基面水位定线报出`
  publishDialogVisible.value = true
}

async function confirmPublish(): Promise<void> {
  if (!publishTargetLine.value) return
  if (!publishForm.operator.trim()) {
    ElMessage.warning('请填写定案 / 报出人')
    return
  }
  busy.value = true
  try {
    const version = await datumStore.publish(publishTargetLine.value.lineNo, publishForm.note.trim(), publishForm.operator.trim())
    ElMessage.success(`${version.versionNo} 已定案报出；后续零点变化不会改动本版，可随时查阅`)
    publishDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定案失败')
  } finally {
    busy.value = false
  }
}

async function reopen(row: DatumLineRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `${row.lineNo} 线已定案。新开版本会把定线退回未定案并按最新零点重算，已报出的历史版本原样保留可查。确认？`,
      '新开版本',
      { type: 'warning', confirmButtonText: '新开版本', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await datumStore.reopen(row.lineNo, row.stationId)
  ElMessage.success('已新开工作稿版本，资料室重算任务已入队')
}

function showVersion(version: RatingVersion): void {
  detailVersion.value = version
  detailVisible.value = true
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">基面折算定线室（资料室）</h2>
        <p class="gb-hint">
          按各点据测流当时那一次水尺零点，把水尺读数折到同一基面（H′ = 读数 + 零点高程）后定线，
          比测偏差与判定跟着重算。站上只管接测登记，两边台账分开。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" :loading="busy" @click="runPending">执行待处理重算</el-button>
        <el-button text type="primary" @click="$router.push('/surveys')">去站上登记接测 / 认点据</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="定线条数" :value="lineRows.length" suffix="条" icon="TrendCharts" tone="info" />
      <StatBadge
        label="待重算 / 失败"
        :value="pendingJobs.length + failedJobs.length"
        suffix="个任务"
        :tone="pendingJobs.length + failedJobs.length > 0 ? 'warning' : 'success'"
        icon="Refresh"
      />
      <StatBadge
        label="待站上认点据"
        :value="unmatchedCount"
        suffix="点"
        :tone="unmatchedCount > 0 ? 'danger' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge label="已定案报出版本" :value="versionCount" suffix="版" icon="DocumentChecked" />
    </div>

    <el-alert
      v-if="failedJobs.length > 0"
      type="error"
      show-icon
      :closable="false"
      title="有重算任务失败：失败只影响资料室工作稿，站上水尺接测记录未受影响，可直接在下方重试。"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>定线台账（按统一基面水位的工作稿 + 定案版本）</h3>
        <span class="gb-hint">H′ 为折到统一基面后的水位；定案报出后零点再变动也不会改动报出版本</span>
      </div>
      <EmptyPanel
        v-if="lineRows.length === 0"
        title="还没有关系点据"
        description="先在关系点据页录入实测点据；站上登记接测后，这里会出现折算重算任务。"
        compact
      />
      <el-table v-else :data="lineRows" border stripe class="gb-table-compact">
        <el-table-column label="定线号" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.lineNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.state?.status ?? 'draft')">
              {{ statusLabel(row.state?.status ?? 'draft') }}
            </el-tag>
            <el-tag v-if="row.state?.needsRecalc" size="small" type="danger" effect="plain" class="page__mini-tag">
              待重算
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已折 / 待认点据" width="130" align="center">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.foldedCount }} 点</span>
            <el-tag v-if="row.unmatchedCount > 0" size="small" type="warning" effect="plain" class="page__mini-tag">
              {{ row.unmatchedCount }} 点待认
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="工作稿定线 Q=a·(H′-H0)^b" min-width="280">
          <template #default="{ row }">
            <span v-if="row.fit.valid" class="gb-mono">
              a={{ row.fit.a }}，b={{ row.fit.b }}，H0={{ row.fit.h0 }}；R²={{ row.fit.r2 }}，平均残差
              {{ row.fit.meanResidualPct }}%
            </span>
            <span v-else class="gb-hint">{{ row.fit.message || '已折点据不足，暂不能定线' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="报出版本" width="120" align="center">
          <template #default="{ row }">
            <el-button v-if="row.latestVersion" link type="primary" :icon="View" @click="showVersion(row.latestVersion)">
              {{ row.latestVersion.versionNo }}
            </el-button>
            <span v-else class="gb-hint">未报出</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Refresh" :loading="busy" @click="recalc(row)">重算</el-button>
            <el-button
              v-if="row.state?.status !== 'finalized'"
              size="small"
              type="primary"
              plain
              :icon="DocumentChecked"
              @click="openPublish(row)"
            >
              定案报出
            </el-button>
            <el-button v-else size="small" plain @click="reopen(row)">新开版本</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>重算任务（失败从这里重试，不影响站上接测记录）</h3>
        <el-button size="small" text type="warning" @click="armFailure">
          演练：让某线下次重算失败一次
        </el-button>
      </div>
      <EmptyPanel
        v-if="datumStore.jobs.length === 0"
        title="暂无重算任务"
        description="站上登记新的接测后，受影响的未定案定线会自动在这里生成重算任务。"
        compact
      />
      <el-table v-else :data="[...pendingJobs, ...failedJobs]" border class="gb-table-compact">
        <el-table-column label="定线号" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.lineNo }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="触发原因" width="130" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="jobTagType(row.status)">{{ jobStatusLabel[row.status] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="尝试次数" width="90" align="center">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.attempts }}</span>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="240">
          <template #default="{ row }">
            <span :class="{ 'page__danger': !!row.errorMessage }">{{ row.errorMessage || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="warning" plain :loading="busy" @click="retryJob(row.id)">
              重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>已定案报出版本（只读留档，原样可查）</h3>
      </div>
      <el-table :data="[...datumStore.versions].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))" border class="gb-table-compact">
        <el-table-column prop="versionNo" label="版本号" width="100" align="center" />
        <el-table-column label="定线号 / 测站" width="160">
          <template #default="{ row }">
            {{ row.lineNo }} 线 · {{ datumStore.stationNameOf(row.stationId) }}
          </template>
        </el-table-column>
        <el-table-column label="报出时定线参数" min-width="280">
          <template #default="{ row }">
            <span class="gb-mono">
              a={{ row.fit.a }}　b={{ row.fit.b }}　H0={{ row.fit.h0 }}　R2={{ row.fit.r2 }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="比测结论" width="150" align="center">
          <template #default="{ row }">
            {{ row.compareCount }} 点 · 合格率 {{ row.qualifyRatePct }}%
            <el-tag v-if="row.overLimitCount > 0" size="small" type="danger" effect="plain" class="page__mini-tag">
              {{ row.overLimitCount }} 超限
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报出人 / 时间" width="200">
          <template #default="{ row }">
            <div>{{ row.operator }}</div>
            <span class="gb-hint gb-mono">{{ new Date(row.publishedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="View" @click="showVersion(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="publishDialogVisible" :title="`${publishTargetLine?.lineNo ?? ''} 线定案报出`" width="480px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="定案后本版定线参数与当时比测结论冻结为只读快照；之后水尺零点再变动只生成重算任务，不改动本版。"
        class="page__publish-alert"
      />
      <el-form label-width="90px">
        <el-form-item label="报出人" required>
          <el-input v-model="publishForm.operator" maxlength="16" />
        </el-form-item>
        <el-form-item label="报出说明">
          <el-input v-model="publishForm.note" type="textarea" :rows="2" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="publishDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="confirmPublish">定案并报出</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="detailVisible" :title="`报出版本 ${detailVersion?.versionNo ?? ''}`" width="760px">
      <template v-if="detailVersion">
        <el-descriptions :column="2" border size="small" class="page__version-desc">
          <el-descriptions-item label="定线号">{{ detailVersion.lineNo }} 线</el-descriptions-item>
          <el-descriptions-item label="报出时间">
            {{ new Date(detailVersion.publishedAt).toLocaleString('zh-CN') }}
          </el-descriptions-item>
          <el-descriptions-item label="定线参数">
            a={{ detailVersion.fit.a }}　b={{ detailVersion.fit.b }}　H0={{ detailVersion.fit.h0 }}
          </el-descriptions-item>
          <el-descriptions-item label="R² / 平均残差">
            {{ detailVersion.fit.r2 }} / {{ detailVersion.fit.meanResidualPct }}%
          </el-descriptions-item>
          <el-descriptions-item label="比测点数 / 合格率">
            {{ detailVersion.compareCount }} 点 / {{ detailVersion.qualifyRatePct }}%
          </el-descriptions-item>
          <el-descriptions-item label="超限点数">{{ detailVersion.overLimitCount }}</el-descriptions-item>
          <el-descriptions-item label="报出人">{{ detailVersion.operator }}</el-descriptions-item>
          <el-descriptions-item label="说明">{{ detailVersion.note || '—' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="detailVersion.points" border size="small" class="gb-table-compact page__version-table">
          <el-table-column label="测流时间" min-width="110">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleDateString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水尺读数 (m)" width="105" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="基面 H′ (m)" width="105" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.datumStageM.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测 / 曲线流量" width="150" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.flowM3s.toFixed(1) }} / {{ row.curveFlowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="当时判定" width="170">
            <template #default="{ row }">
              <DeviationTag :deviation-pct="row.deviationPct" :verdict="row.verdict" :limit="8" />
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__mini-tag {
  margin-left: 6px;
}

.page__danger {
  color: #c0392b;
}

.page__publish-alert {
  margin-bottom: 12px;
}

.page__version-desc {
  margin-bottom: 12px;
}

.page__version-table {
  margin-top: 8px;
}
</style>
