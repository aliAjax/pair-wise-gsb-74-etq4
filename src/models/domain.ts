export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export const PLATFORMS: Platform[] = ['web', 'ios', 'android', 'server', 'miniprogram']

export const PLATFORM_LABELS: Record<Platform, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  server: 'Server',
  miniprogram: '小程序',
}

/** 按端采集状态：矩阵单元格的权威取值 */
export type CollectionState = 'collecting' | 'stopped'

/**
 * 按端采集矩阵单元格。
 * 事件契约 × 平台规则的启停以此为准，平台规则的 enabled 需要与矩阵对齐。
 */
export interface CollectionMatrixCell {
  eventId: string
  platform: Platform
  state: CollectionState
  /** 停采或恢复的依据，如故障单、改造说明或平台规则同步 */
  basis: string
  /** 生效时间 */
  effectiveAt: string
  updatedAt: string
  actor: string
  /** 单元格自身版本号，每次该端启停变化时递增 */
  revision: number
  /** 最近一次变更请求号，用于重复提交幂等判定 */
  changeRequestId?: string
  /** 依据来源：平台规则同步或矩阵直接登记 */
  source: 'rule' | 'manual'
}

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
  /** 按端消费范围；空或未声明表示全量消费所有端 */
  consumptionPlatforms?: Platform[]
}

/** 某端一次停采或恢复的台账记录 */
export interface CollectionChangeRecord {
  id: string
  eventId: string
  platform: Platform
  previous: CollectionState
  next: CollectionState
  basis: string
  effectiveAt: string
  actor: string
  requestId: string
  /** 提交时基于的单元格版本号 */
  baseRevision: number
  createdAt: string
}

/** 并发冲突时，后到提交在单元格上留下的草稿 */
export interface CollectionDraft {
  eventId: string
  platform: Platform
  state: CollectionState
  basis: string
  effectiveAt: string
  requestId: string
  /** 后到者基于的版本号 */
  baseRevision: number
  /** 已落地的最新版本号 */
  conflictRevision: number
  /** 已落地的最新状态 */
  conflictState: CollectionState
  actor: string
  createdAt: string
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
  /** 按端消费的迁移确认；缺省表示历史全量确认 */
  platform?: Platform
  /** 确认时基于的矩阵版本号；该端启停变化后确认立即失效 */
  matrixRevision?: number
  /** 该端启停发生变化，确认失效 */
  invalidated?: boolean
  invalidReason?: string
}

/** 该平台对发布候选的确认与审批；该端启停变化后立即失效 */
export interface PlatformReleaseAck {
  id: string
  platform: Platform
  owner: string
  status: 'pending' | 'confirmed' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
  /** 确认与审批所基于的矩阵单元格版本号 */
  matrixRevision: number
  invalidated?: boolean
  invalidReason?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  /** 各端对候选中按端启停状态的确认和审批 */
  platformAcks: PlatformReleaseAck[]
  createdAt: string
  publishedAt?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
  /** 回滚时按端采集矩阵的快照 */
  matrixSnapshot: CollectionMatrixCell[]
  matrixRevision: number
}

export type MatrixReconciliationKind =
  | 'rule_mismatch'
  | 'stale_ack'
  | 'downstream_risk'

export interface MatrixReconciliationItem {
  kind: MatrixReconciliationKind
  severity: Severity
  eventId: string
  platform: Platform
  detail: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  /** 按端采集矩阵：事件契约 × 平台规则 × 同义属性 × 下游依赖的启停口径 */
  collectionMatrix: CollectionMatrixCell[]
  /** 启停变化台账 */
  collectionChanges: CollectionChangeRecord[]
  /** 并发冲突草稿，后到者留在对应单元格 */
  collectionDrafts: CollectionDraft[]
  matrixRevision: number
  currentVersion: string
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
    | 'matrix_rule_mismatch'
    | 'stopped_platform_consumed'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface CollectionCommitInput {
  eventId: string
  platform: Platform
  state: CollectionState
  basis: string
  effectiveAt: string
  /** 编辑窗口打开时看到的单元格版本号 */
  baseRevision: number
  /** 请求号，相同请求号重复提交不会新增台账与审批 */
  requestId: string
}

export type CollectionCommitOutcome =
  | { status: 'committed'; noop: boolean; cell: CollectionMatrixCell; revision: number }
  | {
      status: 'conflict'
      cell: CollectionMatrixCell
      draft: CollectionDraft
      revision: number
    }
