'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const scriptPath = path.join(__dirname, '../telegram-reconnect.js');
const defaults = {MODE:'reconnect', POLICY_GROUP:'Telegram', INTERVAL:300, HOLD_MS:300, AUTO_TRIGGER:false, NOTIFY:true};
const prefix = 'telegram-reconnect:v1:Telegram:';
async function run(o={}) {
  const source = fs.readFileSync(scriptPath,'utf8');
  let now = o.now === undefined ? 1000000 : o.now, selected = o.selected === undefined ? 'Proxy A' : o.selected;
  const store = o.store || {}, calls=[], notices=[], logs=[], dones=[], timers=[];
  let writes=0, reads=0;
  const ctx = {console:{log:x=>logs.push(String(x))}, Date:{now:()=>now}, Math, JSON,
    $argument:o.noArgs ? undefined : {...defaults,...o.args},
    setTimeout:(fn,ms)=>{timers.push({fn,at:now+ms});return timers.length;},
    $done:x=>dones.push(x),
    $notification:{post:(...x)=>{notices.push(x);if(o.notifyThrow)throw Error('notification');}},
    $persistentStore:{read:k=>{reads++;if(o.readThrow)throw Error('storage');return store[k] ?? null;},write:(v,k)=>{writes++;if(o.writeThrow)throw Error('storage');if(o.writeFail || writes===o.failWriteAt)return false;if(v===undefined)delete store[k];else store[k]=v;if(o.afterWrite)o.afterWrite({k,v,store,selected});return true;}},
    $config:{getSubPolicies:(g,cb)=>{if(o.callbackThrow)throw Error('callback');if(o.noCallback)return;const fn=()=>{cb(o.subText===undefined ? JSON.stringify(['Proxy A','REJECT']) : o.subText);if(o.doubleCallback)cb('["REJECT"]');};ctx.setTimeout(fn,o.callbackDelay||0);},
      getSelectedPolicy:()=>{if(o.selectedThrow)throw Error('selected');return selected;},
      setSelectPolicy:(g,p)=>{calls.push([g,p]);if(o.setHook)return o.setHook({g,p,calls,store,get selected(){return selected;},set selected(v){selected=v;}});selected=p;return true;}}
  };
  if(o.http) {ctx.$request={url:o.url||'https://api.swiftgram.app/test'};Object.defineProperty(ctx.$request,'body',{get(){throw Error('BODY READ');}});ctx.$response={};}
  vm.runInNewContext(source,ctx,{filename:scriptPath});
  for(let i=0;i<40;i++) {
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    timers.sort((a,b)=>a.at-b.at);const t=timers.shift();if(!t)continue;
    now=t.at;if(o.beforeTimer)o.beforeTimer({at:now,store,set now(v){now=v;},set selected(v){selected=v;}});t.fn();
  }
  assert.equal(dones.length,1,'$done exactly once');assert.equal(JSON.stringify(dones[0]),'{}','HTTP/generic no-op');
  return {selected,store,calls,notices,logs,dones,writes,reads};
}
test('normal: REJECT then original; cooldown after restore',async()=>{const r=await run();assert.deepEqual(r.calls,[['Telegram','REJECT'],['Telegram','Proxy A']]);assert.equal(r.selected,'Proxy A');assert.ok(r.store[prefix+'cooldown']);assert.equal(r.store[prefix+'lease'],undefined);});
test('observe never writes or switches; readiness only',async()=>{const r=await run({args:{MODE:'observe'}});assert.equal(r.calls.length,0);assert.equal(r.writes,0);assert.match(r.logs.join(' '),/就绪/);});
test('missing arguments fail closed',async()=>assert.equal((await run({noArgs:true})).calls.length,0));
test('invalid arguments fail closed',async()=>{for(const args of [{MODE:'bad'},{HOLD_MS:99},{HOLD_MS:1501},{INTERVAL:'300'},{INTERVAL:-1},{NOTIFY:'true'},{POLICY_GROUP:''}]) assert.equal((await run({args})).calls.length,0);});
test('no REJECT or missing group or invalid response',async()=>{for(const subText of ['["Proxy A"]','','{}','broken','[1]'])assert.equal((await run({subText})).calls.length,0);});
test('string and object policy shapes are both accepted',async()=>{const objectText=JSON.stringify([{name:'Proxy A'},{name:'REJECT'}]);const r=await run({subText:objectText});assert.equal(r.calls.length,2);assert.equal(r.selected,'Proxy A');});
test('empty or already REJECT current selection',async()=>{for(const selected of ['',null,'REJECT'])assert.equal((await run({selected})).calls.length,0);});
test('cooldown suppresses switch',async()=>assert.equal((await run({store:{[prefix+'cooldown']:'999900'}})).calls.length,0));
test('active lease suppresses switch',async()=>assert.equal((await run({store:{[prefix+'lease']:JSON.stringify({owner:'other',started:999900,expires:1014900,original:'Proxy A'})}})).calls.length,0));
test('time anomaly or corrupted state fail closed',async()=>{for(const store of [{[prefix+'cooldown']:'1000100'},{[prefix+'cooldown']:'NaN'},{[prefix+'lease']:'broken'},{[prefix+'lease']:JSON.stringify({owner:'x',started:1000100,expires:1015100,original:'Proxy A'})}])assert.equal((await run({store})).calls.length,0);assert.equal((await run({now:NaN})).calls.length,0);});
test('switch-out false without change has no success cooldown',async()=>{const r=await run({setHook:()=>false});assert.equal(r.calls.length,1);assert.equal(r.store[prefix+'cooldown'],undefined);});
test('switch-out false or throw after mutation attempts restore',async()=>{for(const throws of [false,true]){const r=await run({setHook:s=>{s.selected=s.p;if(s.p==='REJECT'){if(throws)throw Error('out');return false;}return true;}});assert.equal(r.calls.length,2);assert.equal(r.selected,'Proxy A');assert.equal(r.store[prefix+'cooldown'],undefined);}});
test('switch-out true but readback mismatch is not success',async()=>{const r=await run({setHook:()=>true});assert.equal(r.store[prefix+'cooldown'],undefined);});
test('restore false or throw never records cooldown',async()=>{for(const throws of [false,true]){const r=await run({setHook:s=>{if(s.p==='REJECT'){s.selected=s.p;return true;}if(throws)throw Error('restore');return false;}});assert.equal(r.selected,'REJECT');assert.equal(r.store[prefix+'cooldown'],undefined);assert.ok(r.notices.length);}});
test('user concurrent selection preserved',async()=>{const r=await run({beforeTimer:s=>{if(s.at===1000300)s.selected='User B';}});assert.equal(r.selected,'User B');assert.equal(r.calls.length,1);assert.equal(r.store[prefix+'cooldown'],undefined);assert.ok(r.notices.length);});
test('late callback and missing callback cannot switch',async()=>{for(const o of [{callbackDelay:3000},{noCallback:true}])assert.equal((await run(o)).calls.length,0);});
test('duplicate callback performs at most one cycle',async()=>assert.equal((await run({doubleCallback:true})).calls.length,2));
test('storage failure before switching fails closed',async()=>{for(const o of [{readThrow:true},{writeThrow:true},{writeFail:true}])assert.equal((await run(o)).calls.length,0);});
test('notification throws and restore throws still finish once',async()=>{await run({notifyThrow:true});await run({notifyThrow:true,setHook:s=>{if(s.p==='REJECT'){s.selected=s.p;return true;}throw Error('restore');}});});
test('automatic guard excludes Bot API and lookalike domains',async()=>{for(const url of ['https://api.telegram.org/bot','https://api.swiftgram.app.evil/test','https://api.imem.app@evil/test','http://api.iturrit.com/test'])assert.equal((await run({http:true,url,args:{AUTO_TRIGGER:true}})).calls.length,0);assert.equal((await run({http:true})).calls.length,0);for(const host of ['api.swiftgram.app','api.imem.app','api.iturrit.com'])assert.equal((await run({http:true,url:'https://'+host+'/test',args:{AUTO_TRIGGER:true}})).calls.length,2);});
test('manual entry works while automatic trigger disabled',async()=>assert.equal((await run()).calls.length,2));
test('lease names isolate groups',async()=>{const r=await run({args:{POLICY_GROUP:'Telegram US'}});assert.ok(r.store['telegram-reconnect:v1:Telegram%20US:cooldown']);});
test('plugin Script V2 declaration and shared argument object',()=>{const p=fs.readFileSync(path.join(__dirname,'../telegram-reconnect.plugin'),'utf8');assert.match(p,/#!loon_version/);assert.match(p,/3\.5\.1\(983\)/);assert.equal((p.match(/^response /gm)||[]).length,1);assert.match(p,/^generic then /m);assert.doesNotMatch(p,/\[General\]|\[Rule\]|requires_body=true|api\.telegram\.org/);const urls=[...p.matchAll(/script\("([^"]+)", (\{[^\n]+\})\) with/g)];assert.equal(urls.length,2);assert.equal(urls[0][1],urls[1][1]);assert.match(urls[0][1],/^https:\/\/raw\.githubusercontent\.com\/beckyeeky\/Loon-Rules\/main\/plugins\/experimental\/telegram-reconnect\/telegram-reconnect\.js$/);assert.equal(urls[0][2],urls[1][2]);});
test('lease overwritten before readback prevents mutation',async()=>{const r=await run({afterWrite:s=>{if(s.k.endsWith(':lease')&&s.v)s.store[s.k]=JSON.stringify({owner:'competitor'});}});assert.equal(r.calls.length,0);assert.match(r.store[prefix+'lease'],/competitor/);});
test('cooldown stored only after original selection restored',async()=>{await run({afterWrite:s=>{if(s.k.endsWith(':cooldown'))assert.equal(s.selected,'Proxy A');}});});
test('cooldown write failure still restores and does not claim success',async()=>{const r=await run({failWriteAt:2});assert.equal(r.selected,'Proxy A');assert.equal(r.store[prefix+'cooldown'],undefined);assert.doesNotMatch(r.notices.flat().join(' '),/并记录冷却/);});
test('backward clock during hold restores without success cooldown',async()=>{const r=await run({beforeTimer:s=>{if(s.at===1000300)s.now=900000;}});assert.equal(r.selected,'Proxy A');assert.equal(r.store[prefix+'cooldown'],undefined);});
test('expired lease may be replaced only when current is usable',async()=>{const store={[prefix+'lease']:JSON.stringify({owner:'old',started:900000,expires:915000,original:'Old'})};assert.equal((await run({store})).calls.length,2);assert.equal((await run({store:{...store},selected:'REJECT'})).calls.length,0);});
test('configuration API throws finish safely',async()=>{for(const o of [{callbackThrow:true},{selectedThrow:true}])assert.equal((await run(o)).calls.length,0);});
test('NOTIFY false suppresses notification but retains logs',async()=>{const r=await run({args:{NOTIFY:false}});assert.equal(r.notices.length,0);assert.ok(r.logs.length);});
