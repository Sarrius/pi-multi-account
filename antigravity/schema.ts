import { record } from "../google-transport/http.ts";

/** Cloud Code Assist's legacy parameters field is a protobuf Schema, not JSON Schema.
 * Its enum wire values are strings even when the declared type is integer/boolean.
 * Keep property-name maps separate from schema nodes (a property named `const` is legal).
 * This is a wire projection only; Pi still validates calls against the original schema.
 */
export function antigravityParameters(schema: unknown, forClaude = false): unknown {
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
 // oneOf is equivalent only for provably disjoint types. In particular,
 // integer overlaps number; overlapping anyOf must never be narrowed silently.
 const unionTypes = Array.isArray(schema.anyOf) ? schema.anyOf.map(child =>
  record(child) && typeof child.type === "string" && ["string", "boolean", "object", "array", "number", "integer", "null"].includes(child.type)
   ? child.type === "integer" ? "number" : child.type : undefined) : [];
 const disjoint = unionTypes.length > 0 && unionTypes.every(type => type !== undefined) && new Set(unionTypes).size === unionTypes.length;
 if (forClaude && disjoint && Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf)) {
  result.oneOf = schema.anyOf;
  delete result.anyOf;
 }
 for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
  if (record(result[key])) result[key] = Object.fromEntries(
   Object.entries(result[key] as Record<string, unknown>).map(([name, child]) => [name, antigravityParameters(child, forClaude)]));
 }
 for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) {
  if (record(result[key])) result[key] = antigravityParameters(result[key], forClaude);
 }
 for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
  if (Array.isArray(result[key])) result[key] = (result[key] as unknown[]).map(child => antigravityParameters(child, forClaude));
 }
 return result;
}
