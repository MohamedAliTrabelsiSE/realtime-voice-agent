import { z } from 'zod';
import { ToolRegistry, ToolUserError } from './tool-registry';

class DomainError extends Error {}

describe('ToolRegistry', () => {
  const ctx = { sessionId: 's1' };
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry((err) =>
      err instanceof DomainError ? new ToolUserError('domain', err.message) : null,
    );
    registry
      .register({
        name: 'add',
        description: 'Add two numbers',
        schema: z.object({ a: z.number(), b: z.number().describe('second') }),
        execute: ({ a, b }, c) => ({ sum: a + b, session: c.sessionId }),
      })
      .register({
        name: 'echo',
        description: 'Returns a primitive',
        schema: z.object({}),
        execute: async () => 'pong',
      })
      .register({
        name: 'boom',
        description: 'Fails',
        schema: z.object({ kind: z.enum(['domain', 'user', 'bug']) }),
        execute: ({ kind }) => {
          if (kind === 'domain') throw new DomainError('slot taken');
          if (kind === 'user') throw new ToolUserError('nope', 'not allowed');
          throw new Error('null pointer');
        },
      });
  });

  it('publishes OpenAI function specs with JSON Schema parameters', () => {
    const [add] = registry.specs();
    expect(add).toEqual({
      type: 'function',
      name: 'add',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number', description: 'second' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    });
    expect(registry.names()).toEqual(['add', 'echo', 'boom']);
  });

  it('refuses duplicate names', () => {
    expect(() =>
      registry.register({
        name: 'add',
        description: '',
        schema: z.object({}),
        execute: () => ({}),
      }),
    ).toThrow('already registered');
  });

  it('validates arguments and executes', async () => {
    await expect(registry.execute('add', '{"a":2,"b":3}', ctx)).resolves.toEqual({
      ok: true,
      args: { a: 2, b: 3 },
      result: { ok: true, sum: 5, session: 's1' },
    });
  });

  it('wraps primitive results and accepts empty arguments', async () => {
    await expect(registry.execute('echo', '', ctx)).resolves.toMatchObject({
      ok: true,
      result: { ok: true, value: 'pong' },
    });
  });

  it.each([
    ['nope', '{}', 'unknown_tool'],
    ['add', '{bad json', 'invalid_arguments'],
    ['add', '{"a":"2"}', 'invalid_arguments'],
  ])('fails %s(%s) with %s', async (name, args, code) => {
    const outcome = await registry.execute(name, args, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toMatchObject({ ok: false, code });
  });

  it('explains which arguments are invalid', async () => {
    const outcome = await registry.execute('add', '{"a":1}', ctx);
    expect(outcome.result).toMatchObject({ error: expect.stringContaining('b:') });
  });

  it('surfaces mapped and user errors but hides unexpected ones', async () => {
    await expect(registry.execute('boom', '{"kind":"domain"}', ctx)).resolves.toMatchObject({
      result: { code: 'domain', error: 'slot taken' },
    });
    await expect(registry.execute('boom', '{"kind":"user"}', ctx)).resolves.toMatchObject({
      result: { code: 'nope', error: 'not allowed' },
    });
    await expect(registry.execute('boom', '{"kind":"bug"}', ctx)).resolves.toMatchObject({
      result: { code: 'internal_error', error: 'The tool failed unexpectedly' },
    });
  });

  it('defaults to no error mapping', async () => {
    const plain = new ToolRegistry().register({
      name: 't',
      description: '',
      schema: z.object({}),
      execute: () => {
        throw new DomainError('x');
      },
    });
    await expect(plain.execute('t', '{}', ctx)).resolves.toMatchObject({
      result: { code: 'internal_error' },
    });
  });
});
