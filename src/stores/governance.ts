import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CollectionCommitInput,
  CollectionCommitOutcome,
  CollectionMatrixCell,
  CollectionState,
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  Platform,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  armNextWriteFailure,
  createId,
  loadState,
  resetState,
  saveState,
  subscribeExternalState,
} from '@/services/repository'
import {
  cellKey,
  dependencyConsumes,
  downstreamConsumers,
  eventMatrixCells,
  releaseAckPlatforms,
} from '@/services/matrix'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'

const stateLabel = (state: CollectionState): string =>
  state === 'stopped' ? '停采' : '恢复采集'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  /** 最近一次跨窗口同步时间 */
  const lastExternalSyncAt = ref('')

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  /** 另一个窗口写入后，以本地存储中的完整矩阵覆盖本窗口工作副本 */
  const subscribeExternalChanges = (() => {
    let unsubscribe: (() => void) | null = null
    return (): void => {
      if (unsubscribe) return
      unsubscribe = subscribeExternalState((state) => {
        data.value = state
        lastExternalSyncAt.value = new Date().toISOString()
      })
    }
  })()

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

  /** 该端启停变化后，评审中候选的该平台确认与审批立即失效 */
  const invalidatePlatformGateways = (
    state: GovernanceState,
    eventId: string,
    platform: Platform,
    next: CollectionState,
  ): void => {
    state.releases
      .filter((release) => release.status === 'reviewing' && release.eventIds.includes(eventId))
      .forEach((release) => {
        release.platformAcks
          .filter((ack) => ack.platform === platform && !ack.invalidated)
          .forEach((ack) => {
            ack.invalidated = true
            ack.status = 'pending'
            ack.comment = ''
            ack.createdAt = undefined
            ack.invalidReason = `该事件 ${platform} 端已${stateLabel(next)}，原确认与审批立即失效，需按最新矩阵重新确认。`
          })
        release.migrationConfirmations
          .filter((confirmation) => {
            if (confirmation.platform && confirmation.platform !== platform) return false
            const dependency = state.dependencies.find(
              (item) => item.id === confirmation.dependencyId,
            )
            return Boolean(dependency && dependencyConsumes(dependency, platform))
          })
          .forEach((confirmation) => {
            confirmation.invalidated = true
            confirmation.status = 'pending'
            confirmation.invalidReason = `${platform} 端已${stateLabel(
              next,
            )}，该下游在该端的消费口径需要重新确认。`
          })
      })
  }

  const syncRuleEnabled = (state: GovernanceState, cell: CollectionMatrixCell): void => {
    const event = state.events.find((item) => item.id === cell.eventId)
    const rule = event?.platformRules.find((item) => item.platform === cell.platform)
    if (rule) rule.enabled = cell.state === 'collecting'
  }

  /**
   * 在克隆出的完整状态上应用一次按端启停：
   * 单元格更新/新增、平台规则对齐、台账、下游与审批失效。
   */
  const applyMatrixChange = (
    state: GovernanceState,
    input: CollectionCommitInput,
    baseCell: CollectionMatrixCell | undefined,
  ): CollectionMatrixCell => {
    const now = new Date().toISOString()
    const event = state.events.find((item) => item.id === input.eventId)
    const rule = event?.platformRules.find((item) => item.platform === input.platform)
    const next: CollectionMatrixCell = {
      eventId: input.eventId,
      platform: input.platform,
      state: input.state,
      basis: input.basis,
      effectiveAt: input.effectiveAt,
      updatedAt: now,
      actor: '当前用户',
      revision: (baseCell?.revision ?? 0) + 1,
      changeRequestId: input.requestId,
      source: rule ? 'rule' : 'manual',
    }
    const index = state.collectionMatrix.findIndex(
      (cell) => cell.eventId === input.eventId && cell.platform === input.platform,
    )
    if (index >= 0) {
      state.collectionMatrix[index] = next
    } else {
      state.collectionMatrix.push(next)
    }
    syncRuleEnabled(state, next)
    state.matrixRevision = Math.max(state.matrixRevision, next.revision)
    if (!baseCell || baseCell.state !== input.state) {
      state.collectionChanges.unshift({
        id: createId('chg'),
        eventId: input.eventId,
        platform: input.platform,
        previous: baseCell?.state ?? 'collecting',
        next: input.state,
        basis: input.basis,
        effectiveAt: input.effectiveAt,
        actor: '当前用户',
        requestId: input.requestId,
        baseRevision: input.baseRevision,
        createdAt: now,
      })
    }
    invalidatePlatformGateways(state, input.eventId, input.platform, input.state)
    state.audit.unshift({
      id: createId('aud'),
      entityType: 'collection_matrix',
      entityId: cellKey(input.eventId, input.platform),
      action: input.state === 'stopped' ? '按端停采' : '按端恢复采集',
      actor: '当前用户',
      detail: `${event?.key ?? input.eventId}/${input.platform} 已${stateLabel(
        input.state,
      )}，生效时间 ${input.effectiveAt}；依据：${input.basis}`,
      createdAt: now,
    })
    return next
  }

  /**
   * 提交按端启停。
   * - 重复提交（同一 requestId）不新增台账与审批；
   * - 两个窗口同时改同一端，后到者留下冲突草稿并看到冲突；
   * - 写入失败时从本地存储的完整矩阵恢复，内存不保留半成品。
   */
  const commitCollectionChange = (input: CollectionCommitInput): CollectionCommitOutcome => {
    const latest = loadState()
    const current = latest.collectionMatrix.find(
      (cell) => cell.eventId === input.eventId && cell.platform === input.platform,
    )

    if (current && current.changeRequestId === input.requestId) {
      data.value = latest
      return { status: 'committed', noop: true, cell: current, revision: latest.matrixRevision }
    }

    if (current && current.revision !== input.baseRevision) {
      const draft = {
        eventId: input.eventId,
        platform: input.platform,
        state: input.state,
        basis: input.basis,
        effectiveAt: input.effectiveAt,
        requestId: input.requestId,
        baseRevision: input.baseRevision,
        conflictRevision: current.revision,
        conflictState: current.state,
        actor: '当前用户',
        createdAt: new Date().toISOString(),
      }
      const conflicted = structuredClone(latest)
      conflicted.collectionDrafts = [
        ...conflicted.collectionDrafts.filter(
          (item) =>
            !(item.eventId === draft.eventId && item.platform === draft.platform),
        ),
        draft,
      ]
      try {
        saveState(conflicted)
        data.value = conflicted
      } catch {
        data.value = loadState()
        throw new Error('冲突草稿写入失败，已从完整矩阵恢复')
      }
      return {
        status: 'conflict',
        cell: current,
        draft,
        revision: latest.matrixRevision,
      }
    }

    const candidate = structuredClone(latest)
    const cell = applyMatrixChange(candidate, input, current)
    // 覆盖提交会消费该单元格上待处理的冲突草稿
    candidate.collectionDrafts = candidate.collectionDrafts.filter(
      (draft) => !(draft.eventId === input.eventId && draft.platform === input.platform),
    )
    try {
      saveState(candidate)
    } catch {
      // 写入失败：丢弃半成品内存，从完整矩阵恢复
      data.value = loadState()
      throw new Error('写入失败，已从本地完整矩阵恢复，本次提交未生效')
    }
    data.value = candidate
    lastSavedAt.value = new Date().toISOString()
    return { status: 'committed', noop: false, cell, revision: candidate.matrixRevision }
  }

  /** 演示用：模拟另一个窗口先完成同一端的一次启停提交 */
  const simulateExternalCommit = (input: CollectionCommitInput): void => {
    const latest = loadState()
    const current = latest.collectionMatrix.find(
      (cell) => cell.eventId === input.eventId && cell.platform === input.platform,
    )
    if (current && current.changeRequestId === input.requestId) return
    const candidate = structuredClone(latest)
    applyMatrixChange(
      candidate,
      { ...input, basis: `【另一窗口】${input.basis}` },
      current,
    )
    // 直接落盘但不更新本窗口内存，模拟并发窗口
    saveState(candidate)
  }

  /** 冲突草稿经确认后覆盖提交；放弃则移除草稿 */
  const resolveCollectionDraft = (
    eventId: string,
    platform: Platform,
    apply: boolean,
  ): void => {
    const draft = data.value.collectionDrafts.find(
      (item) => item.eventId === eventId && item.platform === platform,
    )
    if (!draft) return
    if (apply) {
      const cell = data.value.collectionMatrix.find(
        (item) => item.eventId === eventId && item.platform === platform,
      )
      commitCollectionChange({
        eventId,
        platform,
        state: draft.state,
        basis: draft.basis,
        effectiveAt: draft.effectiveAt,
        baseRevision: cell?.revision ?? draft.conflictRevision,
        requestId: draft.requestId,
      })
    }
    // 无论采用还是放弃，都把草稿从持久化矩阵状态中移除
    data.value.collectionDrafts = data.value.collectionDrafts.filter(
      (item) => !(item.eventId === eventId && item.platform === platform),
    )
    persist()
  }

  const armWriteFailure = (): void => {
    armNextWriteFailure()
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
    const previous = index >= 0 ? event.platformRules[index] : undefined
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()

    // 平台规则启停与按端矩阵保持一致：规则 enabled 变化视为该端启停变化
    if (!previous || previous.enabled !== rule.enabled) {
      const desired: CollectionState = rule.enabled ? 'collecting' : 'stopped'
      const candidate = structuredClone(data.value)
      const targetCell = candidate.collectionMatrix.find(
        (item) => item.eventId === eventId && item.platform === rule.platform,
      )
      if (!targetCell || targetCell.state !== desired) {
        applyMatrixChange(
          candidate,
          {
            eventId,
            platform: rule.platform,
            state: desired,
            basis: rule.enabled
              ? `平台规则恢复采集：${rule.note || event.key}`
              : `平台规则停止采集：${rule.note || event.key}`,
            effectiveAt: new Date().toISOString(),
            baseRevision: targetCell?.revision ?? 0,
            requestId: createId('rule-req'),
          },
          targetCell,
        )
        data.value = candidate
        persist()
        audit(
          'platform_rule',
          rule.id,
          index >= 0 ? '更新平台规则并同步矩阵' : '新增平台规则',
          `${event.key}/${rule.platform} 规则与采集矩阵已对齐`,
        )
        return
      }
    }
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const differences = contractDifferences(data.value, eventIds)
    // 受影响下游：契约属性变化 + 候选事件在矩阵中已停采但仍被下游消费的端
    const propertyAffected = new Set(affectedDependencies(data.value, differences))
    const stopAffected = new Set<string>()
    eventIds.forEach((eventId) => {
      eventMatrixCells(data.value, eventId)
        .filter((cell) => cell.state === 'stopped')
        .forEach((cell) => {
          downstreamConsumers(data.value, eventId, cell.platform).forEach((dependency) =>
            stopAffected.add(dependency.id),
          )
        })
    })
    const affected = [...new Set([...propertyAffected, ...stopAffected])]

    const migrationConfirmations: ReleaseCandidate['migrationConfirmations'] = []
    affected.forEach((dependencyId) => {
      const dependency = data.value.dependencies.find((item) => item.id === dependencyId)
      if (!dependency) return
      // 与候选事件相关且被下游消费的端，逐端要求迁移确认；空平台为历史全量确认
      const platforms = new Set<Platform>()
      eventIds
        .filter((eventIdInScope) => dependency.eventIds.includes(eventIdInScope))
        .forEach((eventIdInScope) => {
          eventMatrixCells(data.value, eventIdInScope)
            .filter((cell) => dependencyConsumes(dependency, cell.platform))
            .forEach((cell) => platforms.add(cell.platform))
        })
      const targetPlatforms = [...platforms]
      if (targetPlatforms.length === 0) {
        migrationConfirmations.push({
          id: createId('mig'),
          dependencyId,
          version,
          status: 'pending',
          reviewer: dependency.owner,
          note: '',
        })
      }
      targetPlatforms.forEach((platform) => {
        const cell = eventIds
          .map((eventIdInScope) =>
            data.value.collectionMatrix.find(
              (item) => item.eventId === eventIdInScope && item.platform === platform,
            ),
          )
          .find(Boolean)
        migrationConfirmations.push({
          id: createId('mig'),
          dependencyId,
          version,
          status: 'pending',
          reviewer: dependency.owner,
          note: '',
          platform,
          matrixRevision: cell?.revision ?? 0,
        })
      })
    })

    const platformAcks: ReleaseCandidate['platformAcks'] = releaseAckPlatforms(
      data.value.collectionMatrix,
      eventIds,
    ).map((platform) => {
      const revision = Math.max(
        0,
        ...eventIds.map((eventId) => {
          const cell = data.value.collectionMatrix.find(
            (item) => item.eventId === eventId && item.platform === platform,
          )
          return cell?.revision ?? 0
        }),
      )
      const owner =
        data.value.events
          .flatMap((event) => event.platformRules)
          .find((rule) => rule.platform === platform)?.owner ?? `${platform} 平台负责人`
      return {
        id: createId('ack'),
        platform,
        owner,
        status: 'pending' as const,
        comment: '',
        matrixRevision: revision,
      }
    })

    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations,
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      platformAcks,
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖，需 ${platformAcks.length} 端确认审批`,
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
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
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
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
  }

  /** 该平台对发布候选的确认（confirmed）与审批（approved/rejected），以当前矩阵版本为准 */
  const updatePlatformAck = (
    releaseId: string,
    platform: Platform,
    status: 'confirmed' | 'approved' | 'rejected',
    comment: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    let ack = release.platformAcks.find((item) => item.platform === platform)
    const revision = Math.max(
      0,
      ...release.eventIds.map((eventId) => {
        const cell = data.value.collectionMatrix.find(
          (item) => item.eventId === eventId && item.platform === platform,
        )
        return cell?.revision ?? 0
      }),
    )
    if (!ack) {
      ack = {
        id: createId('ack'),
        platform,
        owner: `${platform} 平台负责人`,
        status,
        comment,
        matrixRevision: revision,
        createdAt: new Date().toISOString(),
      }
      release.platformAcks.push(ack)
    }
    if (ack.invalidated) {
      ack.invalidated = false
      ack.invalidReason = undefined
    }
    ack.status = status
    ack.comment = comment
    ack.matrixRevision = revision
    ack.createdAt = new Date().toISOString()
    audit(
      'release',
      releaseId,
      status === 'approved' ? '按端审批通过' : status === 'rejected' ? '按端审批驳回' : '按端确认',
      `${platform}：${comment}`,
    )
    persist()
  }

  /** 下游迁移确认同样幂等：已经确认且未失效时，重复提交不重复登记 */
  const confirmPlatformMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find(
      (item) => item.id === confirmationId,
    )
    if (!confirmation) return
    if (
      confirmation.status === 'confirmed' &&
      !confirmation.invalidated &&
      confirmation.reviewer === reviewer
    ) {
      return
    }
    confirmation.status = 'confirmed'
    confirmation.invalidated = false
    confirmation.invalidReason = undefined
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit(
      'dependency',
      confirmation.dependencyId,
      '按端确认迁移',
      `${reviewer}/${confirmation.platform ?? '全端'}：${note}`,
    )
    persist()
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady =
      release.migrationConfirmations.length > 0 &&
      release.migrationConfirmations.every(
        (item) => item.status === 'confirmed' && !item.invalidated,
      )
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    const acksReady =
      release.platformAcks.length > 0 &&
      releaseAckPlatforms(data.value.collectionMatrix, release.eventIds).every((platform) =>
        release.platformAcks.some(
          (ack) => ack.platform === platform && ack.status === 'approved' && !ack.invalidated,
        ),
      )
    if (!migrationsReady || !approvalsReady || !acksReady || readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: structuredClone(event.properties),
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
      // 废弃“停采”逐端落到矩阵：仍在采集的端分别停采，记录同一依据和生效时间
      const candidate = structuredClone(data.value)
      const stoppedAt = new Date(`${plan.stopCollectAt}T00:00:00+08:00`).toISOString()
      event.platformRules.forEach((rule) => {
        const cell = candidate.collectionMatrix.find(
          (item) => item.eventId === plan.eventId && item.platform === rule.platform,
        )
        if (!cell || cell.state === 'collecting') {
          applyMatrixChange(
            candidate,
            {
              eventId: plan.eventId,
              platform: rule.platform,
              state: 'stopped',
              basis: `废弃计划 ${plan.id} 到停采日期：${plan.reason}`,
              effectiveAt: stoppedAt,
              baseRevision: cell?.revision ?? 0,
              requestId: createId('deprecate-req'),
            },
            cell,
          )
        }
      })
      data.value = candidate
      const allStopped = eventMatrixCells(data.value, plan.eventId).every(
        (cell) => cell.state === 'stopped',
      )
      if (allStopped) {
        const target = data.value.events.find((item) => item.id === plan.eventId)
        if (target) target.status = 'deprecated'
      }
    }
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    // 回滚留存完整按端矩阵快照，供回滚后按矩阵对账
    const matrixSnapshot = structuredClone(
      data.value.collectionMatrix.filter((cell) => release.eventIds.includes(cell.eventId)),
    )
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
      matrixSnapshot,
      matrixRevision: data.value.matrixRevision,
    }
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `${release.version}：${reason}；快照含 ${matrixSnapshot.length} 个按端采集单元`,
    )
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚并对账按端矩阵', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
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
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          collectionMatrix: eventMatrixCells(data.value, event.id).map((cell) => ({
            platform: cell.platform,
            state: cell.state,
            basis: cell.basis,
            effectiveAt: cell.effectiveAt,
            actor: cell.actor,
            revision: cell.revision,
            downstream: downstreamConsumers(data.value, event.id, cell.platform).map(
              (dependency) => ({
                id: dependency.id,
                name: dependency.name,
                consumption:
                  dependency.consumptionPlatforms && dependency.consumptionPlatforms.length > 0
                    ? dependency.consumptionPlatforms
                    : 'all',
              }),
            ),
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description, synonyms, platforms }) => ({
              name,
              type,
              required,
              enumValues,
              description,
              synonyms,
              platforms,
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
    lastExternalSyncAt,
    issues,
    subscribeExternalChanges,
    commitCollectionChange,
    simulateExternalCommit,
    resolveCollectionDraft,
    armWriteFailure,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    confirmPlatformMigration,
    updatePlatformAck,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
