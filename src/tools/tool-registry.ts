import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { RealtimeToolSpec } from '../realtime/realtime.types';

export interface ToolContext {
  sessionId: string;
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>, ctx: ToolContext): unknown;
}

interface RegisteredTool {
  name: string;
  description: string;
  schema: z.ZodType;
  execute(args: unknown, ctx: ToolContext): unknown;
}

/** `result` is the JSON object returned to the model; it always carries `ok`. */
export interface ToolOutcome {
  ok: boolean;
  args: unknown;
  result: Record<string, unknown>;
}

/** Errors whose message is safe and useful to show the model (and therefore the caller). */
export class ToolUserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Holds the function tools exposed to the model. Each tool is declared once with a zod
 * schema, which is used both to publish JSON Schema to the model and to validate the
 * arguments the model sends back (models occasionally send malformed arguments).
 */
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly mapError: (err: unknown) => ToolUserError | null = () => null) {}

  register<S extends z.ZodType>(def: ToolDefinition<S>): this {
    if (this.tools.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`);
    this.tools.set(def.name, def as unknown as RegisteredTool);
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(): RealtimeToolSpec[] {
    return [...this.tools.values()].map((t) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<
        string,
        unknown
      >;
      return { type: 'function', name: t.name, description: t.description, parameters };
    });
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return fail(rawArgs, 'unknown_tool', `Unknown tool "${name}"`);

    let json: unknown;
    try {
      json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return fail(rawArgs, 'invalid_arguments', 'Arguments are not valid JSON');
    }

    const parsed = tool.schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return fail(json, 'invalid_arguments', issues);
    }

    try {
      const value = await tool.execute(parsed.data, ctx);
      const result =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { value };
      return { ok: true, args: parsed.data, result: { ok: true, ...result } };
    } catch (err) {
      const userError = err instanceof ToolUserError ? err : this.mapError(err);
      if (userError) return fail(parsed.data, userError.code, userError.message);
      this.logger.error(`Tool ${name} failed: ${(err as Error).message}`);
      return fail(parsed.data, 'internal_error', 'The tool failed unexpectedly');
    }
  }
}

function fail(args: unknown, code: string, error: string): ToolOutcome {
  return { ok: false, args, result: { ok: false, error, code } };
}
