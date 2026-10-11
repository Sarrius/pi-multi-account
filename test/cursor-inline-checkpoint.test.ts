import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMessages,requestActionText,systemPromptForRebuild} from '../cursor/message-parsing.ts';
const checkpoint=(summary:string)=>'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'+summary+'\n</summary>';
function parsed(summary:string,request='Finish the remaining work.') {return parseMessages([{role:'user',content:checkpoint(summary)},{role:'assistant',content:'checkpoint retained'},{role:'user',content:request}]);}
test('a small canonical checkpoint reaches Cursor inline as well as the complete root prompt',()=>{
 const summary='TASK_A PROJECT_A EUR CONSTRAINT_X DONE_1 NEXT_STEP_C';const p=parsed(summary);
 const action=requestActionText(p,{hasCheckpoint:false});assert.ok(action.includes(summary),'a local system blob alone is not sufficient delivery evidence');assert.ok(action.endsWith('Finish the remaining work.'));
 assert.ok(systemPromptForRebuild('SYSTEM',p,{hasCheckpoint:false}).includes(summary));
});
test('only the latest canonical summary is repeated inline, never foreign ordinary history',()=>{
 const p=parseMessages([{role:'user',content:checkpoint('OLD_CHECKPOINT')},{role:'assistant',content:'old'},{role:'user',content:checkpoint('CURRENT_PROJECT_A')},{role:'assistant',content:'new'},{role:'user',content:'OTHER_PROJECT_REFERENCE is historical text'},{role:'assistant',content:'historical'},{role:'user',content:'Finish.'}]);
 const action=requestActionText(p,{hasCheckpoint:false});assert.match(action,/CURRENT_PROJECT_A/);assert.doesNotMatch(action,/OLD_CHECKPOINT|OTHER_PROJECT_REFERENCE/);assert.ok(action.endsWith('Finish.'));
});
test('an unusable latest checkpoint never falls back to an older inline checkpoint',()=>{
 for(const latest of [checkpoint('x'.repeat(33000)),checkpoint('')+' malformed latest checkpoint']){
  const p=parseMessages([{role:'user',content:checkpoint('OLD_PROJECT_MUST_NOT_REPLAY')},{role:'assistant',content:'old'},
   {role:'user',content:latest},{role:'assistant',content:'latest'},{role:'user',content:'Finish.'}]);
  assert.equal(requestActionText(p,{hasCheckpoint:false}),'Finish.');
  assert.ok(systemPromptForRebuild('SYSTEM',p,{hasCheckpoint:false}).includes(latest),'root transcript remains intact');
 }
});
test('large summaries and actions remain complete in the root context without recreating the known 50KB inline stall',()=>{
 for(const summary of ['λ'.repeat(18000),'x'.repeat(33000)]){
  const p=parsed(summary);assert.equal(requestActionText(p,{hasCheckpoint:false}),'Finish the remaining work.');assert.ok(systemPromptForRebuild('SYSTEM',p,{hasCheckpoint:false}).includes(summary),'never truncate or substitute the summary');
 }
 const request='owner-request'.repeat(3500),p=parsed('small checkpoint',request);assert.equal(requestActionText(p,{hasCheckpoint:false}),request,'do not enlarge a large existing owner action');
});
test('ordinary requests and healthy checkpoint resumes keep their existing action behavior',()=>{
 const p=parseMessages([{role:'user',content:'unrelated ordinary history'},{role:'assistant',content:'done'},{role:'user',content:'Next task.'}]);assert.equal(requestActionText(p,{hasCheckpoint:false}),'Next task.');
 const compacted=parsed('small checkpoint');assert.equal(requestActionText(compacted,{hasCheckpoint:true}),'Finish the remaining work.');
});
