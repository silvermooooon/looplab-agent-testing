import { Ajv, type ValidateFunction } from "ajv";
import type { AgentTool, AgentToolCall } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false });
const validators = new WeakMap<object, ValidateFunction>();

/** Schemas are immutable after registration. Validation never rewrites transcript arguments. */
export function validateToolArguments(
  tool: AgentTool<any>,
  call: AgentToolCall,
): unknown {
  let validate = validators.get(tool.parameters);
  if (!validate) {
    validate = ajv.compile(tool.parameters);
    validators.set(tool.parameters, validate);
  }
  const args: unknown = structuredClone(call.arguments);
  if (!validate(args))
    throw new Error(
      `Invalid arguments for ${tool.name}: ${ajv.errorsText(validate.errors)}`,
    );
  return args;
}
