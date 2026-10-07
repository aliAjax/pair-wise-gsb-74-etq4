<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  CheckCircleIcon,
  FileSearchIcon,
  HistoryIcon,
  RollbackIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { MatrixReconciliation, RollbackRecord } from '@/models/domain'
import { PLATFORM_LABELS } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const rollbackVisible = ref(false)
const verifyVisible = ref(false)
const selectedRollbackId = ref('')
const form = reactive({
  releaseId: store.data.releases[0]?.id ?? '',
  reason: '',
  scope: '',
  evidence: '',
})
const verifyForm = reactive({
  evidence: '',
})

const rollbackRecords = computed(() =>
  store.data.rollbacks.map((record) => ({
    ...record,
    release: store.data.releases.find((release) => release.id === record.releaseId),
  })),
)

const eventKey = (eventId: string): string =>
  store.data.events.find((event) => event.id === eventId)?.key ?? eventId

const mismatches = (record: RollbackRecord): MatrixReconciliation[] =>
  (record.matrixChecks ?? []).filter((check) => !check.consistent)

const stateLabel = (state: string): string =>
  ({ collecting: '采集中', stopped: '已停采', not_configured: '未接入' })[state] ?? state

const openRollback = (): void => {
  form.releaseId = store.data.releases.find((release) => release.status === 'published')?.id ?? ''
  form.reason = ''
  form.scope = ''
  form.evidence = ''
  rollbackVisible.value = true
}

const execute = async (): Promise<void> => {
  if (!form.releaseId || !form.reason.trim() || !form.scope.trim() || !form.evidence.trim()) {
    await MessagePlugin.error('版本、回滚原因、影响范围和证据编号不能为空')
    return
  }
  store.executeRollback(form.releaseId, form.reason, form.scope, form.evidence)
  rollbackVisible.value = false
  await MessagePlugin.success('回滚指令已记录，已按采集矩阵完成对账')
}

const reconcile = async (rollbackId: string): Promise<void> => {
  store.reconcileRollback(rollbackId)
  await MessagePlugin.success('已按当前采集矩阵重新对账')
}

const openVerify = (rollbackId: string): void => {
  selectedRollbackId.value = rollbackId
  verifyForm.evidence = ''
  verifyVisible.value = true
}

const verify = async (): Promise<void> => {
  if (!verifyForm.evidence.trim()) {
    await MessagePlugin.error('验证证据不能为空')
    return
  }
  store.verifyRollback(selectedRollbackId.value, verifyForm.evidence)
  verifyVisible.value = false
  await MessagePlugin.success('回滚验证结果已记录')
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="故障恢复"
      title="回滚与验证记录"
      description="记录契约发布后的回滚原因、客户端影响范围、执行证据和业务验证结果。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div>
          <strong>发布回滚台账</strong>
          <p class="page-description">回滚是独立审计记录，不删除原发布版本和下游迁移确认。</p>
        </div>
        <div class="filter-actions">
          <t-button theme="danger" @click="openRollback">
            <template #icon><RollbackIcon /></template>
            执行回滚
          </t-button>
        </div>
      </div>
    </section>

    <div class="rollback-summary">
      <div>
        <HistoryIcon />
        <span>回滚记录</span>
        <strong>{{ rollbackRecords.length }}</strong>
      </div>
      <div>
        <CheckCircleIcon />
        <span>已验证</span>
        <strong>{{ rollbackRecords.filter((record) => record.status === 'verified').length }}</strong>
      </div>
      <div>
        <FileSearchIcon />
        <span>待验证</span>
        <strong>{{ rollbackRecords.filter((record) => record.status === 'executed').length }}</strong>
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">回滚记录</h2>
      </div>
      <div class="rollback-list">
        <article v-for="record in rollbackRecords" :key="record.id" class="rollback-item">
          <div class="rollback-icon">
            <RollbackIcon />
          </div>
          <div class="rollback-main">
            <div class="rollback-head">
              <div>
                <strong>{{ record.version }}</strong>
                <span>{{ record.release?.title ?? '历史发布版本' }}</span>
              </div>
              <StatusTag :value="record.status" />
            </div>
            <p>{{ record.reason }}</p>
            <dl>
              <div>
                <dt>影响范围</dt>
                <dd>{{ record.scope }}</dd>
              </div>
              <div>
                <dt>操作人</dt>
                <dd>{{ record.operator }}</dd>
              </div>
              <div>
                <dt>执行时间</dt>
                <dd>{{ new Date(record.createdAt).toLocaleString('zh-CN') }}</dd>
              </div>
              <div>
                <dt>验证证据</dt>
                <dd>{{ record.evidence }}</dd>
              </div>
            </dl>
            <div v-if="record.matrixChecks?.length" class="matrix-checks">
              <div class="checks-head">
                <strong>矩阵对账</strong>
                <span>
                  {{ record.matrixChecks.filter((check) => check.consistent).length }}/{{
                    record.matrixChecks.length
                  }}
                  端与发布时一致
                </span>
                <t-button variant="text" size="small" @click="reconcile(record.id)">
                  按当前矩阵重新对账
                </t-button>
              </div>
              <ul v-if="mismatches(record).length" class="mismatch-list">
                <li v-for="check in mismatches(record)" :key="`${check.eventId}-${check.platform}`">
                  {{ eventKey(check.eventId) }} / {{ PLATFORM_LABELS[check.platform] }}：发布时
                  {{ stateLabel(check.expected) }} → 当前 {{ stateLabel(check.actual) }}
                </li>
              </ul>
              <span v-else class="checks-ok">各端采集状态与发布时一致。</span>
            </div>
            <t-button
              v-if="record.status === 'executed'"
              theme="primary"
              variant="outline"
              size="small"
              @click="openVerify(record.id)"
            >
              记录验证结果
            </t-button>
          </div>
        </article>
        <div v-if="rollbackRecords.length === 0" class="empty-state">暂无回滚记录。</div>
      </div>
    </section>

    <t-dialog v-model:visible="rollbackVisible" header="执行契约回滚" width="680px" :footer="false">
      <div class="editor-form">
        <div class="field field-wide">
          <label>回滚目标版本</label>
          <t-select
            v-model="form.releaseId"
            :options="
              store.data.releases.map((release) => ({
                label: `${release.version} ${release.title}`,
                value: release.id,
              }))
            "
          />
        </div>
        <div class="field field-wide">
          <label>回滚原因</label>
          <t-textarea v-model="form.reason" :autosize="{ minRows: 3, maxRows: 5 }" />
        </div>
        <div class="field field-wide">
          <label>影响范围</label>
          <t-textarea v-model="form.scope" :autosize="{ minRows: 3, maxRows: 5 }" />
        </div>
        <div class="field field-wide">
          <label>执行证据编号</label>
          <t-input v-model="form.evidence" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="rollbackVisible = false">取消</t-button>
        <t-button theme="danger" @click="execute">确认执行</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="verifyVisible" header="记录回滚验证" width="600px" :footer="false">
      <div class="field">
        <label>验证证据</label>
        <t-textarea
          v-model="verifyForm.evidence"
          :autosize="{ minRows: 5, maxRows: 8 }"
          placeholder="填写指标恢复、客户端行为、工单或监控证据"
        />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="verifyVisible = false">取消</t-button>
        <t-button theme="primary" @click="verify">确认验证</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.rollback-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.rollback-summary > div {
  display: grid;
  grid-template-columns: 30px 1fr auto;
  align-items: center;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.rollback-summary svg {
  color: #1264c5;
}

.rollback-summary span {
  color: #717c8e;
  font-size: 12px;
}

.rollback-summary strong {
  font-size: 22px;
}

.rollback-list {
  display: grid;
}

.rollback-item {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
  padding: 18px;
  border-bottom: 1px solid #e8ebef;
}

.rollback-item:last-child {
  border-bottom: 0;
}

.rollback-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  color: #b42318;
  background: #fff2f0;
}

.rollback-main {
  display: grid;
  gap: 12px;
}

.rollback-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.rollback-head > div {
  display: grid;
  gap: 4px;
}

.rollback-head span {
  color: #737e90;
  font-size: 11px;
}

.rollback-main > p {
  margin: 0;
  color: #596579;
  font-size: 13px;
}

.rollback-main dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.rollback-main dl > div {
  display: grid;
  gap: 5px;
}

.rollback-main dt {
  color: #788295;
  font-size: 10px;
}

.rollback-main dd {
  margin: 0;
  font-size: 11px;
}

.rollback-main :deep(.t-button) {
  justify-self: start;
}

.matrix-checks {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #e3e7ec;
  border-radius: 5px;
  background: #fafbfc;
}

.checks-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.checks-head strong {
  font-size: 12px;
}

.checks-head span {
  color: #6d788b;
  font-size: 11px;
}

.mismatch-list {
  display: grid;
  gap: 5px;
  margin: 0;
  padding-left: 18px;
  color: #b42318;
  font-size: 11px;
}

.checks-ok {
  color: #0f8a62;
  font-size: 11px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
