import assert from "node:assert/strict";
import test from "node:test";
import { semanticRefreshBatch } from "../src/semantic-refresh.ts";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("semantic batches coalesce bursts without postponing the batch indefinitely", async (t) => {
 t.mock.timers.enable({ apis: ["setTimeout"] });
 let calls = 0;
 const batch = semanticRefreshBatch(async () => { calls++; return true; }, () => {});
 t.after(() => batch.close());
 batch.schedule(); t.mock.timers.tick(150_000); batch.schedule(); batch.schedule();
 assert.equal(calls, 0); t.mock.timers.tick(150_000); await settle(); assert.equal(calls, 1);
 t.mock.timers.tick(600_000); await settle(); assert.equal(calls, 1);
 batch.schedule(); t.mock.timers.tick(300_000); await settle(); assert.equal(calls, 2);
});

test("semantic batches retry failed or coalesced requests without losing dirty work", async (t) => {
 t.mock.timers.enable({ apis: ["setTimeout"] });
 let calls = 0; const errors: unknown[] = [];
 const batch = semanticRefreshBatch(async () => { calls++; if(calls === 1) throw new Error("unavailable"); return calls > 2; }, error => errors.push(error));
 t.after(() => batch.close()); batch.schedule();
 for(let i=1;i<=3;i++){t.mock.timers.tick(300_000);await settle();assert.equal(calls,i);}
 assert.match(String(errors[0]), /unavailable/); assert.equal(errors[2], undefined);
 t.mock.timers.tick(300_000);await settle();assert.equal(calls,3);
});

test("new publication during a request schedules a follow-up and shutdown cancels pending work", async (t) => {
 t.mock.timers.enable({ apis: ["setTimeout"] });
 let calls = 0; let release!: () => void; let aborted = false;
 const batch = semanticRefreshBatch(signal => { calls++; return new Promise<boolean>((resolve,reject)=>{ release=()=>resolve(true); signal.addEventListener("abort",()=>{aborted=true;reject(signal.reason);},{once:true}); }); }, () => {});
 batch.schedule();t.mock.timers.tick(300_000);await settle();batch.schedule();release();await settle();
 t.mock.timers.tick(300_000);await settle();assert.equal(calls,2);
 await batch.close();assert.equal(aborted,true);batch.schedule();t.mock.timers.tick(600_000);await settle();assert.equal(calls,2);
 const pending = semanticRefreshBatch(async()=>{throw new Error("must not run");},()=>assert.fail());pending.schedule();await pending.close();t.mock.timers.tick(300_000);await settle();
});
