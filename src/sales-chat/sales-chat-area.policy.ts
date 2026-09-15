import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';

// Only persisted, verified identities may be passed to this policy.
export function allowedSalesChatAreas(
  agent: Pick<SalesAgent, 'id' | 'username' | 'scope' | 'active'>,
): SalesAgentScope[] {
  if (!agent.active) return [];
  const dualIdentity =
    (agent.id === '30000001-0000-4000-8000-000000000001' &&
      agent.username === 'ad1') ||
    (agent.id === '30000002-0000-4000-8000-000000000002' &&
      agent.username === 'ad2');
  return dualIdentity
    ? [SalesAgentScope.PARROT, SalesAgentScope.PRODUCTS]
    : [agent.scope];
}
