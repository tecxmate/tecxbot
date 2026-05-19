import type { TenantConfig } from './types.js';

const defaultTenantId = process.env.DEFAULT_TENANT_ID || 'demo';

const tenants = new Map<string, TenantConfig>([
  [defaultTenantId, {
    id: defaultTenantId,
    name: 'Tecxbot Demo',
    defaultLanguage: 'zh-TW',
    domainContext: 'General business chat automation. Avoid domain-specific claims unless configured by the tenant.',
    botMentionNames: ['tecxbot', 'tecxmate', 'tecxmate.com', 'bot'],
  }],
]);

export function getTenantConfig(tenantId = defaultTenantId): TenantConfig {
  return tenants.get(tenantId) ?? tenants.get(defaultTenantId)!;
}
