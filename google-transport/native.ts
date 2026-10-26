import * as Native from "@earendil-works/pi-ai";
import type { Api, Model, Provider, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";

// Multi Account still supports older hosts. This optional adapter does not emulate
// missing transcript/replay APIs or import absent named exports at module load.
export type NativeContext = Parameters<Provider<Api>["streamSimple"]>[1];
export type NativeStreamOptions = SimpleStreamOptions & {
 onProviderStreamEvent?: (event: unknown, model: Model<Api>) => unknown;
};
interface TranscriptAPI {
 collapseSystemMessages(context: NativeContext): NativeContext;
 getCurrentTools(messages: NativeContext["messages"]): Tool[];
 getCurrentSystemPrompt(messages: NativeContext["messages"]): string | undefined;
 normalizeContext(context: unknown): NativeContext;
}
const api = Native as unknown as Partial<TranscriptAPI>;
export const supportsNativeTranscript = ["collapseSystemMessages", "getCurrentTools", "getCurrentSystemPrompt", "normalizeContext"]
 .every(key => typeof api[key as keyof TranscriptAPI] === "function");
export function requireNativeTranscript(): TranscriptAPI {
 if (!supportsNativeTranscript) throw new Error("Antigravity requires modern native transcript APIs (use Pi 1.1+); other Multi Account providers remain supported on older hosts.");
 return api as TranscriptAPI;
}
export const collapseSystemMessages = (context: NativeContext) => requireNativeTranscript().collapseSystemMessages(context);
export const getCurrentTools = (messages: NativeContext["messages"]) => requireNativeTranscript().getCurrentTools(messages);
export const getCurrentSystemPrompt = (messages: NativeContext["messages"]) => requireNativeTranscript().getCurrentSystemPrompt(messages);
export const normalizeContext = (context: unknown) => requireNativeTranscript().normalizeContext(context);
