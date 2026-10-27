import { record } from "../google-transport/http.ts";

/** Cloud Code Assist's legacy parameters field is a protobuf Schema, not JSON Schema.
 * Its enum wire values are strings even when the declared type is integer/boolean.
 * Keep property-name maps separate from schema nodes (a property named `const` is legal).
 * This is a wire projection only; Pi still validates calls against the original schema.
 */
export function antigravityParameters(schema: unknown): unknown {
 if (!record(schema)) return schema;
 const result: Record<string, unknown> = { ...schema };
 const enumValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "boolean" ||
   (typeof value === "number" && Number.isFinite(value))) return String(value);
  throw new Error("Antigravity tool schema requires scalar, non-null const/enum values");
 };
 if (Object.hasOwn(schema, "const")) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(schema.const))
   throw new Error("Antigravity tool schema has contradictory const/enum constraints");
  result.enum = [enumValue(schema.const)];
  delete result.const;
 } else if (Array.isArray(schema.enum)) result.enum = schema.enum.map(enumValue);
 for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
  if (record(schema[key])) result[key] = Object.fromEntries(
   Object.entries(schema[key]).map(([name, child]) => [name, antigravityParameters(child)]));
 }
 for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) {
  if (record(schema[key])) result[key] = antigravityParameters(schema[key]);
 }
 for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
  if (Array.isArray(schema[key])) result[key] = schema[key].map(antigravityParameters);
 }
 return result;
}
