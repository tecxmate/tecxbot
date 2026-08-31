import type { TenantPlan } from './types.js';

export type UsageAccount = {
  tenantId: string;
  plan: TenantPlan;
  periodStartedAt: number;
  periodEndsAt?: number;
  usedCharacters: number;
};

const usageAccounts = new Map<string, UsageAccount>();

export function getUsageAccount(tenantId: string, defaultPlan: TenantPlan) {
  const existing = usageAccounts.get(tenantId);
  if (existing) return existing;
  const created: UsageAccount = {
    tenantId,
    plan: defaultPlan,
    periodStartedAt: Date.now(),
    usedCharacters: 0,
  };
  usageAccounts.set(tenantId, created);
  return created;
}

export function getRemainingCharacters(tenantId: string, defaultPlan: TenantPlan) {
  const account = getUsageAccount(tenantId, defaultPlan);
  return Math.max(0, account.plan.characterLimit - account.usedCharacters);
}

export function canConsumeCharacters(tenantId: string, defaultPlan: TenantPlan, characters: number) {
  return getRemainingCharacters(tenantId, defaultPlan) >= characters;
}

export function consumeCharacters(tenantId: string, defaultPlan: TenantPlan, characters: number) {
  const account = getUsageAccount(tenantId, defaultPlan);
  account.usedCharacters += Math.max(0, characters);
  return account;
}
