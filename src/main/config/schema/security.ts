// src/main/config/schema/security.ts
// Security 域 Valibot schema
// 依据：S-005 §3.6

import * as v from 'valibot'

const DiagnosticsConfigSchema = v.object({
  logLevel: v.picklist(['error', 'warn', 'info', 'debug']),
  retentionDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30)),
  maxTotalMb: v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(500))
})

const PrivacyConfigSchema = v.object({
  includeCrashDumpsInExport: v.boolean(),
  monthlyGcDigest: v.boolean()
})

/**
 * Security 配置 schema。
 * contextIsolation/nodeIntegration/sandbox/CSP 是不可关闭的安全常量，不是偏好，
 * 不给用户配置（S-005 §3.6）。
 */
export const SecurityConfigSchema = v.object({
  allowHttpLocalhostInDev: v.boolean(),
  diagnostics: DiagnosticsConfigSchema,
  privacy: PrivacyConfigSchema
})
