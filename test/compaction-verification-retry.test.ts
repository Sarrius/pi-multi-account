import assert from 'node:assert/strict';
import test from 'node:test';
import {retryCompactionAccessVerification} from '../compaction-summary.ts';
const outage=()=>new Error('Unable to verify Daybreak Blue access. Please try again.');
test('temporary verification recovery retains the identical operation and succeeds without policy bypass',async()=>{
  let calls=0;const schedule:unknown[]=[];const summary={summary:'TASK_A PROJECT_A NEXT_STEP_C'};
  const result=await retryCompactionAccessVerification(async()=>{calls++;if(calls<3)throw outage();return summary;},{delaysMs:[1,1],onRetry:(...event)=>schedule.push(event)});
  assert.equal(result,summary);assert.equal(calls,3);assert.equal(schedule.length,2);
});
test('verification outage settles after at most two retries, never an endless loop',async()=>{
  let calls=0;
  await assert.rejects(retryCompactionAccessVerification(async()=>{calls++;throw outage();},{delaysMs:[1,1,1,1]}),/Unable to verify/);
  assert.equal(calls,3);
});
test('policy, quota and ordinary failures are not retried by the verification helper',async()=>{
  for(const error of ['This content was flagged for possible cybersecurity risk. Unable to verify Daybreak access.','429 quota exhausted','503 Service unavailable']){
    let calls=0;await assert.rejects(retryCompactionAccessVerification(async()=>{calls++;throw new Error(error);},{delaysMs:[1,1]}));assert.equal(calls,1);
  }
});
test('cancellation before and during backoff cannot start a late retry',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=retryCompactionAccessVerification(async()=>{calls++;throw outage();},{signal:controller.signal,delaysMs:[5000,5000],onRetry:()=>controller.abort()});
  await assert.rejects(pending,/aborted/i);assert.equal(calls,1);
  await assert.rejects(retryCompactionAccessVerification(async()=>{calls++;return null;},{signal:controller.signal}),/aborted/i);assert.equal(calls,1);
});
