import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBashTool} from '@earendil-works/pi-coding-agent';
import {mapNativeExecToPiTool} from '../cursor/stream-lifecycle.ts';

test('native Cursor shell cwd is executed by the actual Pi bash contract, including quotes and failed cd',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cursor-cwd-'));
 try{
  const session=join(root,'session'),target=join(root,"project space's");mkdirSync(session);mkdirSync(target);
  const tool=createBashTool(session);
  const forwarded=mapNativeExecToPiTool('shellArgs',{command:"pwd; printf ok > harmless.txt",workingDirectory:target},['bash'])!;
  assert.equal('cwd' in forwarded.args,false,'unsupported cwd argument cannot pretend to work');
  const result=await tool.execute('cwd-good',forwarded.args as any);
  assert.match(JSON.stringify(result.content),/project space's/);assert.equal(readFileSync(join(target,'harmless.txt'),'utf8'),'ok');assert.equal(existsSync(join(session,'harmless.txt')),false);
  const failed=mapNativeExecToPiTool('shellStreamArgs',{command:'pwd; printf WRONG > escaped.txt',workingDirectory:join(root,'missing')},['bash'])!;
  // Older hosts throw for a nonzero command; modern hosts return an explicit
  // tool error. Both must prove failed cd and cannot execute the remaining script.
  let rejected=false;
  const failedResult:any=await tool.execute('cwd-missing',failed.args as any).catch(error=>{rejected=true;assert.match(String(error),/exited|directory|No such/i);});
  if(!rejected){assert.equal(failedResult.isError,true);assert.match(JSON.stringify(failedResult.content),/exited|directory|No such/i);}
  assert.equal(existsSync(join(session,'escaped.txt')),false,'failed cd must gate the entire multi-command script');
 }finally{rmSync(root,{recursive:true,force:true});}
});
