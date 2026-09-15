import { allowedSalesChatAreas } from './sales-chat-area.policy';
import { SalesAgentScope } from './entities/sales-agent.entity';

describe('allowedSalesChatAreas', () => {
  const agent = (id: string, username: string, scope: SalesAgentScope) => ({
    id,
    username,
    scope,
    active: true,
  });

  it.each([
    ['30000001-0000-4000-8000-000000000001', 'ad1'],
    ['30000002-0000-4000-8000-000000000002', 'ad2'],
  ])('allows %s both chat areas', (id, username) => {
    expect(
      allowedSalesChatAreas(agent(id, username, SalesAgentScope.PARROT)),
    ).toEqual([SalesAgentScope.PARROT, SalesAgentScope.PRODUCTS]);
  });

  it.each([
    ['30000003-0000-4000-8000-000000000003', 'ad3', SalesAgentScope.PARROT],
    ['30000004-0000-4000-8000-000000000004', 'ad4', SalesAgentScope.PARROT],
    ['30000005-0000-4000-8000-000000000005', 'ad5', SalesAgentScope.PRODUCTS],
    ['30000006-0000-4000-8000-000000000006', 'ad6', SalesAgentScope.PRODUCTS],
  ])('keeps %s limited to its persisted scope', (id, username, scope) => {
    expect(allowedSalesChatAreas(agent(id, username, scope))).toEqual([scope]);
  });

  it('does not grant dual access from a username or id alone', () => {
    expect(
      allowedSalesChatAreas(agent('other', 'ad1', SalesAgentScope.PARROT)),
    ).toEqual([SalesAgentScope.PARROT]);
    expect(
      allowedSalesChatAreas(
        agent(
          '30000001-0000-4000-8000-000000000001',
          'other',
          SalesAgentScope.PARROT,
        ),
      ),
    ).toEqual([SalesAgentScope.PARROT]);
  });
});
