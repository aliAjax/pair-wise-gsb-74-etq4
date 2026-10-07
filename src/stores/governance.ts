import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CollectionState,
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  MatrixDraft,
  MatrixReconciliation,
  Platform,
  PlatformCollectionRecord,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
  PLATFORM_LABELS,
  releaseReadiness,
  resolveEventMatrix,
  resolveMatrixCell,
  validateGovernance,
} from '@/services/selectors'

export interface CollectionInput {
  eventId: string
  platform: Platform
  state: CollectionState
  basis: string
  effectiveAt: string
  actor: string
}

export type SaveMatrixResult =
  | { ok: true; unchanged: boolean }
  | { ok: false; reason: 'conflict'; draftId: string }
  | { ok: false; reason: 'error'; message: string }

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  const persistError = ref('')

  const issues = computed(() => validateGovernance(data.value))

  /** 写入失败时丢弃内存中的部分修改，从本地完整矩阵恢复。 */
  const persistState = (target: GovernanceState, failureNote: string): boolean => {
    try {
      saveState(target)
      data.value = target
      lastSavedAt.value = new Date().toISOString()
      persistError.value = ''
      return true
    } catch {
      data.value = loadState()
      persistError.value = failureNote
      return false
    }
  }

  const persist = (): boolean => persistState(data.value, '最近一次写入失败，已从本地完整矩阵恢复。')

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const auditIn = (
    target: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    actor: string,
    detail: string,
  ): void => {
    target.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor,
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /** 某端启停变化：引用该事件的下游确认与在途发布的审批立即失效。 */
  const invalidateMatrixDependents = (
    target: GovernanceState,
    eventId: string,
    platform: Platform,
    now: string,
  ): void => {
    const reason = `${PLATFORM_LABELS[platform]} 端采集状态变更，需重新处理`
    target.releases
      .filter(
        (release) =>
          ['reviewing', 'approved'].includes(release.status) &&
          release.eventIds.includes(eventId),
      )
      .forEach((release) => {
        release.migrationConfirmations.forEach((confirmation) => {
          if (confirmation.status !== 'confirmed') return
          const dependency = target.dependencies.find(
            (item) => item.id === confirmation.dependencyId,
          )
          if (!dependency?.eventIds.includes(eventId)) return
          confirmation.status = 'pending'
          confirmation.invalidatedAt = now
          confirmation.invalidReason = reason
          confirmation.confirmedAt = undefined
          if (dependency.status === 'migrated') dependency.status = 'migration_required'
        })
        release.approvals.forEach((approval) => {
          if (approval.status !== 'approved') return
          approval.status = 'pending'
          approval.invalidatedAt = now
          approval.invalidReason = reason
        })
      })
  }

  /** 在目标状态上落一条采集记录，同步平台规则并按需失效确认与审批。 */
  const applyCollectionRecord = (
    target: GovernanceState,
    input: CollectionInput,
  ): { record: PlatformCollectionRecord; stateChanged: boolean; unchanged: boolean } => {
    const now = new Date().toISOString()
    const event = target.events.find((item) => item.id === input.eventId)
    const before = resolveMatrixCell(target, input.eventId, input.platform).state
    const existing = target.collectionMatrix.find(
      (item) => item.eventId === input.eventId && item.platform === input.platform,
    )
    if (
      existing &&
      existing.state === input.state &&
      existing.basis === input.basis &&
      existing.effectiveAt === input.effectiveAt
    ) {
      return { record: existing, stateChanged: false, unchanged: true }
    }
    const record: PlatformCollectionRecord = {
      id: existing?.id ?? createId('col'),
      eventId: input.eventId,
      platform: input.platform,
      state: input.state,
      basis: input.basis,
      effectiveAt: input.effectiveAt,
      actor: input.actor,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    }
    if (existing) {
      target.collectionMatrix[target.collectionMatrix.indexOf(existing)] = record
    } else {
      target.collectionMatrix.push(record)
    }
    const rule = event?.platformRules.find((item) => item.platform === input.platform)
    if (rule) rule.enabled = input.state === 'collecting'
    if (event) event.updatedAt = now
    target.matrixRevision += 1
    const stateChanged = before !== input.state
    if (stateChanged) invalidateMatrixDependents(target, input.eventId, input.platform, now)
    return { record, stateChanged, unchanged: false }
  }

  /**
   * 矩阵写入入口：先从本地读取完整矩阵做修订号检查，
   * 两个窗口同时改同一端时，后到者留下冲突草稿。
   */
  const saveCollectionRecord = (input: CollectionInput, baseRevision: number): SaveMatrixResult => {
    const fresh = loadState()
    const event = fresh.events.find((item) => item.id === input.eventId)
    if (!event) return { ok: false, reason: 'error', message: `事件不存在：${input.eventId}` }
    const existing = fresh.collectionMatrix.find(
      (item) => item.eventId === input.eventId && item.platform === input.platform,
    )
    const currentRevision = existing?.revision ?? 0
    if (currentRevision !== baseRevision) {
      const draft: MatrixDraft = {
        id: createId('draft'),
        ...input,
        baseRevision,
        conflictRevision: currentRevision,
        createdAt: new Date().toISOString(),
      }
      fresh.matrixDrafts = [
        draft,
        ...fresh.matrixDrafts.filter(
          (item) => !(item.eventId === input.eventId && item.platform === input.platform),
        ),
      ]
      auditIn(
        fresh,
        'collection',
        `${input.eventId}:${input.platform}`,
        '矩阵写入冲突',
        input.actor || '当前用户',
        `基于 r${baseRevision} 的修改与当前 r${currentRevision} 冲突，已保留为草稿`,
      )
      persistState(fresh, '冲突草稿写入失败，已从本地完整矩阵恢复。')
      return { ok: false, reason: 'conflict', draftId: draft.id }
    }
    const { record, stateChanged, unchanged } = applyCollectionRecord(fresh, input)
    if (!unchanged) {
      auditIn(
        fresh,
        'collection',
        record.id,
        input.state === 'stopped' ? '矩阵停采' : '矩阵恢复采集',
        input.actor || '当前用户',
        `${event.key}/${PLATFORM_LABELS[input.platform]}：${
          input.state === 'stopped' ? '停采' : '恢复采集'
        }，依据：${input.basis}，生效 ${input.effectiveAt}${
          stateChanged ? '，相关确认与审批已失效' : ''
        }`,
      )
    }
    return persistState(fresh, '矩阵写入失败，已从本地完整矩阵恢复。')
      ? { ok: true, unchanged }
      : { ok: false, reason: 'error', message: persistError.value }
  }

  /** 覆盖应用冲突草稿：以当前修订号为基准备强制写入。 */
  const applyMatrixDraft = (draftId: string): boolean => {
    const fresh = loadState()
    const draft = fresh.matrixDrafts.find((item) => item.id === draftId)
    if (!draft) return false
    const { record } = applyCollectionRecord(fresh, {
      eventId: draft.eventId,
      platform: draft.platform,
      state: draft.state,
      basis: draft.basis,
      effectiveAt: draft.effectiveAt,
      actor: draft.actor,
    })
    fresh.matrixDrafts = fresh.matrixDrafts.filter((item) => item.id !== draftId)
    auditIn(
      fresh,
      'collection',
      record.id,
      '应用冲突草稿',
      draft.actor || '当前用户',
      `${draft.eventId}/${PLATFORM_LABELS[draft.platform]} 以 r${record.revision} 覆盖写入`,
    )
    return persistState(fresh, '草稿应用失败，已从本地完整矩阵恢复。')
  }

  const discardMatrixDraft = (draftId: string): void => {
    data.value.matrixDrafts = data.value.matrixDrafts.filter((item) => item.id !== draftId)
    persist()
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const duplicated = data.value.releases.find(
      (item) => item.version === version && item.status === 'reviewing',
    )
    if (duplicated) return duplicated
    const differences = contractDifferences(data.value, eventIds)
    const affected = affectedDependencies(data.value, differences)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      matrixSnapshot: [],
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!confirmation) return
    if (
      confirmation.status === 'confirmed' &&
      confirmation.reviewer === reviewer &&
      confirmation.note === note
    ) {
      return
    }
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    confirmation.invalidatedAt = undefined
    confirmation.invalidReason = undefined
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist()
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!approval) return
    if (approval.status === status && approval.comment === comment && approval.actor === actor) {
      return
    }
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    approval.invalidatedAt = undefined
    approval.invalidReason = undefined
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady = release.migrationConfirmations.every((item) => item.status === 'confirmed')
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    if (!migrationsReady || !approvalsReady || readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    release.matrixSnapshot = release.eventIds.flatMap((eventId) =>
      resolveEventMatrix(data.value, eventId)
        .filter((cell) => cell.source !== 'none')
        .map((cell) => ({
          eventId,
          platform: cell.platform,
          state: cell.state === 'collecting' ? ('collecting' as const) : ('stopped' as const),
          revision: cell.revision,
        })),
    )
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: JSON.parse(JSON.stringify(event.properties)) as EventProperty[],
          createdAt: new Date().toISOString(),
          status: 'published',
        })
      }
    })
    audit('release', release.id, '发布契约', `${release.version} 已发布`)
    persist()
    return true
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') {
      event.status = 'deprecated'
      event.platformRules.forEach((rule) => {
        applyCollectionRecord(data.value, {
          eventId: event.id,
          platform: rule.platform,
          state: 'stopped',
          basis: `废弃计划 ${plan.id}：${plan.reason}`,
          effectiveAt: plan.stopCollectAt,
          actor: plan.owner,
        })
      })
    }
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  const reconcileRollbackRecord = (record: RollbackRecord): void => {
    const release = data.value.releases.find((item) => item.id === record.releaseId)
    if (!release?.matrixSnapshot?.length) {
      record.matrixChecks = []
      return
    }
    record.matrixChecks = release.matrixSnapshot.map(
      (stamp): MatrixReconciliation => {
        const cell = resolveMatrixCell(data.value, stamp.eventId, stamp.platform)
        return {
          eventId: stamp.eventId,
          platform: stamp.platform,
          expected: stamp.state,
          actual: cell.state,
          consistent: cell.state === stamp.state,
        }
      },
    )
  }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
      matrixChecks: [],
    }
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'
    reconcileRollbackRecord(record)
    audit('rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    persist()
  }

  /** 回滚后按矩阵对账：以发布快照为基准重新核对各端采集状态。 */
  const reconcileRollback = (rollbackId: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    reconcileRollbackRecord(record)
    const consistent = record.matrixChecks?.filter((check) => check.consistent).length ?? 0
    const total = record.matrixChecks?.length ?? 0
    audit('rollback', record.id, '矩阵对账', `各端采集状态 ${consistent}/${total} 与发布时一致`)
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
    persistError.value = ''
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: resolveEventMatrix(data.value, event.id)
            .filter((cell) => cell.source !== 'none')
            .map((cell) => ({
              platform: cell.platform,
              enabled: cell.state === 'collecting',
              state: cell.state,
              basis: cell.basis,
              effectiveAt: cell.effectiveAt,
              trigger:
                event.platformRules.find((rule) => rule.platform === cell.platform)?.trigger ?? '',
            })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    persistError,
    issues,
    saveCollectionRecord,
    applyMatrixDraft,
    discardMatrixDraft,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    reconcileRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
