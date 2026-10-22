import { z } from "zod";
const str = z.string().min(1).max(4000);
const selector = z.string().min(1).max(1000);
export const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: str }).strict(),
  z
    .object({
      action: z.literal("fill"),
      selector,
      value: z.string().max(10000),
    })
    .strict(),
  z.object({ action: z.literal("click"), selector }).strict(),
  z.object({ action: z.literal("press"), selector, key: str }).strict(),
  z.object({ action: z.literal("assertText"), selector, text: str }).strict(),
  z.object({ action: z.literal("assertVisible"), selector }).strict(),
  z.object({ action: z.literal("waitFor"), selector }).strict(),
  z.object({ action: z.literal("screenshot"), name: str }).strict(),
  z
    .object({
      action: z.literal("extractText"),
      selector,
      output: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    })
    .strict(),
]);
export const specSchema = z
  .object({
    inputs: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/))
      .max(30)
      .default([]),
    steps: z.array(stepSchema).min(1).max(40),
  })
  .strict();
export type Step = z.infer<typeof stepSchema>;
export type NodeSpec = z.infer<typeof specSchema>;
export const flowStepSchema = z
  .object({
    revisionId: z.string().uuid(),
    params: z.record(z.string().max(10000)).default({}),
  })
  .strict();
export const flowSchema = z.array(flowStepSchema).min(1).max(40);
export type FlowStep = z.infer<typeof flowStepSchema>;
export interface Variables {
  baseUrl: string;
  param: Record<string, string>;
  secret: Record<string, string>;
  var: Record<string, string>;
  output: Record<string, string>;
}
export function interpolate(value: string, context: Variables) {
  return value.replace(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g, (_, path: string) => {
    if (path === "baseUrl") return context.baseUrl;
    const [scope, key, ...rest] = path.split(".");
    if (
      rest.length ||
      !key ||
      !["param", "secret", "var", "output"].includes(scope!)
    )
      throw new Error(`Unknown variable: ${path}`);
    const group = context[scope as "param" | "secret" | "var" | "output"];
    if (!Object.hasOwn(group, key))
      throw new Error(`Missing variable: ${path}`);
    return group[key]!;
  });
}
export const stepJson = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "navigate",
        "fill",
        "click",
        "press",
        "assertText",
        "assertVisible",
        "waitFor",
        "screenshot",
        "extractText",
      ],
    },
    url: { type: "string" },
    selector: { type: "string" },
    value: { type: "string" },
    key: { type: "string" },
    text: { type: "string" },
    name: { type: "string" },
    output: { type: "string" },
  },
  required: ["action"],
  additionalProperties: false,
};
/** Exported implementations are derived from the same validated specs the runner executes. */
export function nodeSource(key: string, spec: NodeSpec) {
  return `// Reusable node: ${key}\nexport const inputs = ${JSON.stringify(spec.inputs)};\nexport const steps = ${JSON.stringify(spec.steps, null, 2)} as const;\n`;
}
