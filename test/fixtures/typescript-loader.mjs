// Test-only loader for generated protobuf enums on Node versions without transform-types.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({load(url,context,nextLoad) {
  if(url.startsWith('file:') && url.endsWith('.ts')) return {
    format:'module',shortCircuit:true,
    source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{
      compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext},
    }).outputText,
  };
  return nextLoad(url,context);
}});
