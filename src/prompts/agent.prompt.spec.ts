import { buildAgentInstructions, buildGreeting } from './agent.prompt';

describe('agent prompt', () => {
  const base = {
    businessName: 'Acme Physio',
    timezone: 'Europe/London',
    nowLocal: '2026-01-05T08:00',
    openingHour: 8,
    closingHour: 18,
  };

  it('injects business facts and booking rules', () => {
    const text = buildAgentInstructions(base);
    expect(text).toContain('receptionist for Acme Physio');
    expect(text).toContain('8:00 to 18:00 (Europe/London)');
    expect(text).toContain('Current local time: 2026-01-05T08:00');
    expect(text).toContain('list_available_slots');
    expect(text).toContain('wait for an explicit yes before calling book_appointment');
    expect(text).not.toContain('The caller identified');
  });

  it('mentions the caller name when known', () => {
    expect(buildAgentInstructions({ ...base, callerName: 'Ann' })).toContain(
      'The caller identified as Ann.',
    );
  });

  it('builds a greeting', () => {
    expect(buildGreeting('Acme Physio')).toBe(
      'Hello, thank you for calling Acme Physio. How can I help you today?',
    );
  });
});
